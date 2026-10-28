import { paceChat } from './chat-pacing';
import { aiCharacterPermissions, key } from '@voxel/shared';
import type {
  AgentAction,
  AgentConfig,
  BatchResult,
  Observation,
} from '../../contracts';
import { AgentRuntimeError } from '../../contracts/errors';
import type { AgentSession } from '../../world/session/port';
import type { AgentRunState } from '../../contracts/state';
import { initialToolState, type ToolState } from '../../contracts/tool-state';
import { TaskService, type TaskLease } from '../task/service';
import type { AgentAttention } from '../../world/observe/attention';
import { mergeSignals, withDeadline } from '../../kernel/abort';
import { executeBatch } from '../../world/actions/batch';
import { houseBlocks } from '../../world/actions/build';
import { worldSignature } from '../../world/observe/extract';
import { observedEmpty } from '../../world/observe/verify';
import { recordEvent } from '../task/inbox';
import type { RequestBudget } from '../task/budget';

/**
 * Task-bound Action Execution Adapter:
 * Bridges runtime-level TaskService invariants, memory persistence, and budget limits
 * with the underlying physical batch executor (`executeBatch` in `actions/batch.ts`).
 *
 * Responsibilities:
 * - Guarantees session calls conform to the active `TaskLease`
 * - Merges and tracks unfinished blueprint builds across model turns
 * - Manages continuous follow pursuit state checkpoints
 * - Enforces task private routing for chat actions
 */
export async function executeTaskActions(
  session: AgentSession,
  actions: AgentAction[],
  observation: Observation,
  config: AgentConfig,
  signal: AbortSignal,
  memory: AgentRunState,
  budget: RequestBudget,
  lease: TaskLease,
  checkpoint: () => Promise<void>,
  attention?: AgentAttention,
  log: (message: string) => void = () => {},
) {
  const service = new TaskService(memory);
  service.assertCurrent(lease);
  signal.throwIfAborted();
  const guardedSession: AgentSession = {
    observe: () => {
      service.assertCurrent(lease);
      return session.observe();
    },
    move: (x, z, jump) => {
      if (x || z || jump) service.assertCurrent(lease);
      session.move(x, z, jump);
    },
    request: (type, payload) => {
      service.assertCurrent(lease);
      return session.request(type, payload);
    },
  };
  const task = memory.task.current!;
  const routed = actions.map(
    (action): AgentAction =>
      action.type === 'chat' && task.privateTo
        ? { ...action, scope: 'private', recipients: [task.privateTo] }
        : action,
  );
  const deadline = withDeadline(signal, budget.remainingMs, 'task_timeout');
  let outcome;
  // Keep older unfinished coordinates when a new batch only works on a subset.
  const priorBuild = memory.effects.unfinishedBuild;
  const followControl = { pursuing: true };
  try {
    outcome = await executeBatch(
      guardedSession,
      routed,
      observation,
      aiCharacterPermissions(config),
      deadline.signal,
      {
        navigation: { follow: followControl },
        pending: () => !!attention?.pending,
        log,
        beforeAction: async (action) => {
          service.assertCurrent(lease);
          signal.throwIfAborted();
          if (action.type === 'chat') await paceChat(memory, signal);
          if (action.type === 'follow') {
            memory.effects.follow = {
              action,
              taskStartedAt: task.startedAt,
              pursuing: true,
            };
            await checkpoint();
          }
          if (action.type === 'goto') delete memory.effects.follow;
          if (action.type === 'build' || action.type === 'house') {
            const blocks =
              action.type === 'house' ? houseBlocks(action) : action.blocks;
            const extra =
              priorBuild?.result.remaining.filter(
                (b) => !blocks.some((p) => key(p) === key(b)),
              ) ?? [];
            memory.effects.unfinishedBuild = {
              action,
              result: {
                ok: false,
                total: blocks.length + extra.length,
                completed: 0,
                skipped: 0,
                remaining: [...extra, ...blocks],
                failures: [],
                note: '执行中；未确认的动作不会自动重放。',
              },
            };
            await checkpoint();
          }
        },
        buildCheckpoint: (action, result) => {
          service.assertCurrent(lease);
          const blocks =
            action.type === 'house' ? houseBlocks(action) : action.blocks;
          const extra =
            priorBuild?.result.remaining.filter(
              (b) => !blocks.some((p) => key(p) === key(b)),
            ) ?? [];
          const merged = {
            ...result,
            remaining: [...extra, ...result.remaining],
            ok: result.ok && !extra.length,
            total: result.total + extra.length,
            uncertain: [
              ...(priorBuild?.result.uncertain?.filter((b) =>
                extra.some((p) => key(p) === key(b)),
              ) ?? []),
              ...(result.uncertain ?? []),
            ],
          };
          memory.effects.unfinishedBuild = merged.ok
            ? undefined
            : { action, result: merged };
        },
        checkpoint: async (batch) => {
          service.assertCurrent(lease);
          memory.effects.previous = batch;
          // Confirmed individual edits can also finish part of an older blueprint.
          if (memory.effects.unfinishedBuild) {
            memory.effects.unfinishedBuild.result.remaining =
              memory.effects.unfinishedBuild.result.remaining.filter(
                (b) =>
                  !batch.results.some(
                    (r) =>
                      r.status === 'succeeded' &&
                      r.action.type === 'edit' &&
                      key(r.action) === key(b) &&
                      r.action.material === b.material,
                  ),
              );
            if (!memory.effects.unfinishedBuild.result.remaining.length)
              memory.effects.unfinishedBuild = undefined;
          }
          await checkpoint();
        },
      },
    );
  } finally {
    deadline.clear();
  }
  service.assertCurrent(lease);
  const { batch, observation: finalObservation } = outcome;
  const followResult = batch.results.find(
    (r) => r.action.type === 'follow',
  )?.result;
  if (memory.effects.follow && followResult && 'status' in followResult) {
    memory.effects.follow.pursuing = followControl.pursuing;
    memory.effects.follow.lastResult = followResult;
    if (!followResult.ok) delete memory.effects.follow;
  }
  if (deadline.expired || budget.remainingMs <= 0) {
    batch.stopReason = 'timeout';
    batch.ok = false;
  }
  memory.effects.previous = batch;
  if (batch.ok) delete memory.health.decisionError;
  await checkpoint();
  signal.throwIfAborted();
  return { batch, observation: finalObservation };
}

export type TurnActionContext = {
  id: string;
  action: AgentAction;
  lease: TaskLease;
  session: AgentSession;
  config: AgentConfig;
  budget: RequestBudget;
  service: TaskService;
  memory: AgentRunState;
  state: ToolState;
  activeSignal: AbortSignal;
  attention?: AgentAttention;
  log?: (message: string) => void;
  observation: () => Observation;
  refreshObservation: (observation: Observation) => Promise<void>;
  save: () => Promise<void>;
  launch: (id: string, controller: AbortController, work: Promise<void>) => void;
};

/**
 * Runs a single world action for a turn: executes synchronous actions inline,
 * or launches long-running actions (goto, build, house) into the background slot
 * and records an `action_result` inbox event when settled.
 */
export async function executeTurnWorldAction(
  ctx: TurnActionContext,
): Promise<unknown> {
  const { id, action, lease } = ctx;
  const name = action.type;
  const background = ['goto', 'build', 'house'].includes(name);
  const controller = new AbortController();
  const signal = mergeSignals(ctx.activeSignal, controller.signal);
  const state = background ? initialToolState() : ctx.state;

  if (!background) {
    const valueResult = await runSingleWorldAction(ctx, {
      id,
      name,
      action,
      lease,
      signal,
      state,
      background: false,
    });
    if (name === 'follow' && ctx.memory.effects.follow)
      ctx.memory.effects.activeAction = {
        id,
        name,
        taskId: lease.id,
        revision: lease.revision,
        status: 'running',
      };
    return valueResult;
  }

  return launchBackgroundWorldAction(ctx, {
    id,
    name,
    lease,
    controller,
    work: runSingleWorldAction(ctx, {
      id,
      name,
      action,
      lease,
      signal,
      state,
      background: true,
    }),
  });
}

async function runSingleWorldAction(
  ctx: TurnActionContext,
  input: {
    id: string;
    name: string;
    action: AgentAction;
    lease: TaskLease;
    signal: AbortSignal;
    state: ToolState;
    background: boolean;
  },
) {
  const { id, name, action, lease, signal, state, background } = input;
  signal.throwIfAborted();
  ctx.service.assertCurrent(lease);
  if (
    state.terminal ||
    state.skipBatch ||
    (!background && !!ctx.attention?.pending)
  )
    throw new AgentRuntimeError('当前批次已停止。');
  if (
    ctx.memory.checkpoint.unknownEffect?.name === name &&
    ['chat', 'goto', 'follow'].includes(name)
  )
    throw new AgentRuntimeError(
      '上次聊天或移动结果未知，不能自动重放；请核对结果或等待玩家明确的新指令。',
    );

  ctx.memory.checkpoint.pi ??= {
    version: 2,
    taskId: lease.id,
    revision: lease.revision,
    taskStartedAt: lease.startedAt,
    audience: ctx.memory.task.current?.privateTo ?? 'public',
    messages: [],
  };
  ctx.memory.checkpoint.pi.inFlight = { id, name, state: 'executing' };
  await ctx.save();

  let known = false;
  try {
    const outcome = await executeTaskActions(
      ctx.session,
      [action],
      ctx.observation(),
      ctx.config,
      signal,
      ctx.memory,
      ctx.budget,
      lease,
      () => ctx.save(),
      background ? undefined : ctx.attention,
      ctx.log,
    );
    await ctx.refreshObservation(outcome.observation);
    const { batch } = outcome;
    known = batch.stopReason !== 'unknown' && batch.stopReason !== 'executing';
    if (!batch.ok) {
      if (['goto', 'follow', 'edit', 'build', 'house'].includes(name))
        ctx.memory.effects.pendingEffects = batch;
      state.skipBatch = true;
      throw new AgentRuntimeError(JSON.stringify(batch));
    }
    if (name === 'follow' && ctx.memory.effects.follow) {
      ctx.service.finish(lease, {
        status: 'waiting',
        reason: '持续跟随中，由本地导航控制器推进。',
        waitFor: 'players',
        signature: worldSignature(ctx.observation(), 'players'),
      });
      state.terminal = true;
    }
    if (['goto', 'follow', 'edit', 'build', 'house'].includes(name))
      state.turnMutated = true;
    return formatActionResult(action, batch, ctx.observation(), ctx.memory);
  } finally {
    if (ctx.service.current(lease) && !state.persistenceFailed) {
      if (known && ctx.memory.checkpoint.pi?.inFlight?.id === id)
        delete ctx.memory.checkpoint.pi.inFlight;
      await ctx.save();
    }
  }
}

function formatActionResult(
  action: AgentAction,
  batch: BatchResult,
  observation: Observation,
  memory: AgentRunState,
) {
  const edits =
    action.type === 'edit'
      ? [action]
      : action.type === 'build'
        ? action.blocks
        : action.type === 'house'
          ? houseBlocks(action)
          : [];
  const unconfirmed = edits.filter((edit) =>
    edit.material === null
      ? !observedEmpty(observation, edit)
      : !observation.blocks.some(
          (b) =>
            b.x === edit.x &&
            b.y === edit.y &&
            b.z === edit.z &&
            b.material === edit.material,
        ),
  );
  return {
    batch,
    ...(edits.length
      ? {
          verification: {
            requested: edits.length,
            observedMatching: edits.length - unconfirmed.length,
            unconfirmed,
          },
        }
      : {}),
    position: observation.self,
    revision: observation.revision,
    unfinishedBuild: memory.effects.unfinishedBuild,
  };
}

async function launchBackgroundWorldAction(
  ctx: TurnActionContext,
  input: {
    id: string;
    name: string;
    lease: TaskLease;
    controller: AbortController;
    work: Promise<unknown>;
  },
) {
  const { id, name, lease, controller, work } = input;
  ctx.memory.effects.activeAction = {
    id,
    name,
    taskId: lease.id,
    revision: lease.revision,
    status: 'running',
  };
  await ctx.save();
  const tracked = work
    .then(
      (value) => {
        if (ctx.service.current(lease))
          ctx.memory.effects.activeAction = {
            id,
            name,
            taskId: lease.id,
            revision: lease.revision,
            status: 'completed',
            result: {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(value, (key, val) =>
                    key === 'batchId' ? undefined : val,
                  ),
                },
              ],
              details: {},
            },
          };
      },
      (error) => {
        if (ctx.service.current(lease))
          ctx.memory.effects.activeAction = {
            id,
            name,
            taskId: lease.id,
            revision: lease.revision,
            status: ctx.activeSignal.aborted ? 'unknown' : 'failed',
            result: String(error),
          };
      },
    )
    .then(async () => {
      if (ctx.service.current(lease))
        recordEvent(ctx.memory, {
          id: `action:${id}`,
          kind: 'action_result',
          state: 'pending',
          at: Date.now(),
          audience: ctx.memory.task.current?.privateTo ?? 'public',
          taskId: lease.id,
          revision: lease.revision,
          actionId: id,
        });
      await ctx.save();
    });
  ctx.launch(id, controller, tracked);
  ctx.state.terminal = true;
  return { actionId: id, status: 'running' };
}
