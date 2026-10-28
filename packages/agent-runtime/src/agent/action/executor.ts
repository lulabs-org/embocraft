import { aiCharacterPermissions } from '@voxel/shared';
import type { AgentAction, AgentConfig, Observation } from '../../contracts';
import { AgentRuntimeError } from '../../contracts/errors';
import type { RuntimeState } from '../../contracts/state';
import type { TaskLease } from '../../contracts/task';
import { initialToolState, type ToolState } from '../../contracts/tool-state';
import { mergeSignals, withDeadline } from '../../kernel/abort';
import { executeBatch } from '../../world/actions/batch';
import type { AgentAttention } from '../../world/observe/attention';
import type { AgentSession } from '../../world/session/port';
import type { RequestBudget } from '../task/budget';
import { TaskService } from '../task/service';
import { formatActionResult } from './build-tracker';
import { paceChat } from './chat-pacing';
import {
  actionPolicy,
  activateContinuingAction,
  createActionEffects,
  settleActionEffects,
} from './effects';
import { launchBackgroundWorldAction } from './lifecycle';

function guardSessionWithLease(
  session: AgentSession,
  service: TaskService,
  lease: TaskLease,
): AgentSession {
  return {
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
}

function routeTaskActions(
  actions: AgentAction[],
  privateTo?: string,
): AgentAction[] {
  if (!privateTo) return actions;
  return actions.map((action) =>
    action.type === 'chat'
      ? { ...action, scope: 'private', recipients: [privateTo] }
      : action,
  );
}

/**
 * Task-bound Action Execution Adapter:
 * Bridges runtime-level TaskService invariants, memory persistence, and budget limits
 * with the underlying physical batch executor (`executeBatch` in `actions/batch.ts`).
 */
export async function executeTaskActions(
  session: AgentSession,
  actions: AgentAction[],
  observation: Observation,
  config: AgentConfig,
  signal: AbortSignal,
  memory: RuntimeState,
  budget: RequestBudget,
  lease: TaskLease,
  checkpoint: () => Promise<void>,
  attention?: AgentAttention,
  log: (message: string) => void = () => {},
) {
  const service = new TaskService(memory);
  service.assertCurrent(lease);
  signal.throwIfAborted();

  const task = memory.execution.task.current!;
  const routed = routeTaskActions(actions, task.privateTo);
  const deadline = withDeadline(signal, budget.remainingMs, 'task_timeout');
  const effects = createActionEffects(memory, checkpoint);

  let outcome;
  try {
    outcome = await executeBatch(
      guardSessionWithLease(session, service, lease),
      routed,
      observation,
      aiCharacterPermissions(config),
      deadline.signal,
      {
        navigation: effects.navigation,
        pending: () => !!attention?.pending,
        log,
        beforeAction: async (action) => {
          service.assertCurrent(lease);
          signal.throwIfAborted();
          if (action.type === 'chat') await paceChat(memory, signal);
          await effects.beforeAction(action);
        },
        buildCheckpoint: (action, result) => {
          service.assertCurrent(lease);
          effects.buildCheckpoint(action, result);
        },
        checkpoint: async (batch) => {
          service.assertCurrent(lease);
          memory.execution.effects.previous = batch;
          effects.checkpoint(batch);
          await checkpoint();
        },
      },
    );
  } finally {
    deadline.clear();
  }

  service.assertCurrent(lease);
  const { batch, observation: finalObservation } = outcome;
  effects.complete(batch);
  if (deadline.expired || budget.remainingMs <= 0) {
    batch.stopReason = 'timeout';
    batch.ok = false;
  }
  memory.execution.effects.previous = batch;
  if (batch.ok) delete memory.execution.health.decisionError;
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
  memory: RuntimeState;
  state: ToolState;
  activeSignal: AbortSignal;
  attention?: AgentAttention;
  log?: (message: string) => void;
  observation: () => Observation;
  refreshObservation: (observation: Observation) => Promise<void>;
  save: () => Promise<void>;
  launch: (
    id: string,
    controller: AbortController,
    work: Promise<void>,
  ) => void;
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
  const background = actionPolicy(name).background;
  const controller = new AbortController();
  const signal = mergeSignals(ctx.activeSignal, controller.signal);
  const state = background ? initialToolState() : ctx.state;
  const work = runSingleWorldAction(ctx, signal, state, background);

  if (!background) {
    const valueResult = await work;
    activateContinuingAction(name, ctx.memory, id, lease);
    return valueResult;
  }

  return launchBackgroundWorldAction(ctx, {
    id,
    name,
    lease,
    controller,
    work,
  });
}

async function runSingleWorldAction(
  ctx: TurnActionContext,
  signal: AbortSignal,
  state: ToolState,
  background: boolean,
) {
  const { id, action, lease, memory } = ctx;
  const name = action.type;

  signal.throwIfAborted();
  ctx.service.assertCurrent(lease);
  if (
    state.terminal ||
    state.skipBatch ||
    (!background && !!ctx.attention?.pending)
  )
    throw new AgentRuntimeError('当前批次已停止。');
  if (
    memory.execution.checkpoint.unknownEffect?.name === name &&
    actionPolicy(name).blocksUnknownReplay
  )
    throw new AgentRuntimeError(
      '上次聊天或移动结果未知，不能自动重放；请核对结果或等待玩家明确的新指令。',
    );

  memory.execution.checkpoint.pi ??= {
    version: 3,
    taskId: lease.id,
    revision: lease.revision,
    taskStartedAt: lease.startedAt,
    audience: memory.execution.task.current?.privateTo ?? 'public',
    messages: [],
  };
  memory.execution.checkpoint.pi.inFlight = { id, name, state: 'executing' };
  await ctx.save();

  let known = false;
  try {
    const outcome = await executeTaskActions(
      ctx.session,
      [action],
      ctx.observation(),
      ctx.config,
      signal,
      memory,
      ctx.budget,
      lease,
      () => ctx.save(),
      background ? undefined : ctx.attention,
      ctx.log,
    );
    await ctx.refreshObservation(outcome.observation);
    const { batch } = outcome;
    known = batch.stopReason !== 'unknown' && batch.stopReason !== 'executing';
    const mutating = actionPolicy(name).mutating;
    if (!batch.ok) {
      if (mutating) memory.execution.effects.pendingEffects = batch;
      state.skipBatch = true;
      throw new AgentRuntimeError(JSON.stringify(batch));
    }
    settleActionEffects(
      name,
      memory,
      ctx.service,
      lease,
      ctx.observation(),
      state,
    );
    if (mutating) state.turnMutated = true;
    return formatActionResult(action, batch, ctx.observation(), memory);
  } finally {
    if (ctx.service.current(lease) && !state.persistenceFailed) {
      if (known && memory.execution.checkpoint.pi?.inFlight?.id === id)
        delete memory.execution.checkpoint.pi.inFlight;
      await ctx.save();
    }
  }
}
