import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentAction, BatchResult, Observation } from '../../contracts';
import { AgentRuntimeError } from '../../contracts/errors';
import type { AgentRunState } from '../../contracts/state';
import { initialToolState, type ToolState } from '../../contracts/tool-state';
import { mergeSignals } from '../../kernel/abort';
import { houseBlocks } from '../../world/actions/build';
import { worldSignature } from '../../world/observe/extract';
import { observedEmpty } from '../../world/observe/verify';
import { executeTaskActions } from '../action/executor';
import { recordEvent } from '../task/inbox';
import type { TaskLease } from '../task/service';
import { isActiveTask } from '../task/state';
import type { ToolHost } from './port';
import { worldToolSchemas } from './schema';

const result = (value: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify(value, (key, val) =>
        key === 'batchId' ? undefined : val,
      ),
    },
  ],
  details: {},
});

/**
 * World observation and physical action tools (observe, chat, goto, follow, edit, build, house).
 * Directly executes against the task-bound action executor without nested tool factories.
 */
export function createRuntimeWorldTools(o: ToolHost): AgentTool[] {
  return Object.entries(worldToolSchemas).map(([name, parameters]) => ({
    name,
    label: name,
    parameters,
    description: ['goto', 'build', 'house'].includes(name)
      ? `Start ${name}; returns an action ID. Completion arrives as an action_result event. Never start a second action while one runs.`
      : `Use ${name} for the current authorized activity. If no task exists, first call start_task(goal); a world tool never creates a task implicitly.`,
    execute: async (id, value) => {
      if (name === 'chat' && o.message) {
        const args = value as { text: string; relatedToTask?: boolean };
        await o.respond(args.text, args.relatedToTask);
        return result({ replied: true });
      }
      if (name === 'observe') {
        await o.observe();
        return result({
          observation: o.prepared().observation,
          activity: o.prepared().context,
        });
      }
      o.authorize();
      if (o.actionBusy())
        throw new AgentRuntimeError(
          '当前动作尚未结束，请读取进度或先明确停止。',
        );
      if (!isActiveTask(o.memory.task.current))
        throw new AgentRuntimeError(
          'No active running task. For a NEW human action request, call start_task(goal) FIRST, then retry the world tool. Do not claim completion: no world action was executed. A paused or exhausted task must be resumed, never recreated.',
        );
      o.attach();
      const lease = o.service.lease();
      const background = ['goto', 'build', 'house'].includes(name);
      const controller = new AbortController();
      const signal = mergeSignals(o.activeSignal, controller.signal);
      const state = background ? initialToolState() : o.state;
      const action = {
        ...(value as Record<string, unknown>),
        type: name,
      } as AgentAction;

      if (!background) {
        const valueResult = await runWorldAction(o, {
          id,
          name,
          action,
          lease,
          signal,
          state,
          background: false,
        });
        if (name === 'follow' && o.memory.effects.follow)
          o.memory.effects.activeAction = {
            id,
            name,
            taskId: lease.id,
            revision: lease.revision,
            status: 'running',
          };
        return valueResult;
      }

      return launchBackgroundAction(o, {
        id,
        name,
        lease,
        controller,
        work: runWorldAction(o, {
          id,
          name,
          action,
          lease,
          signal,
          state,
          background: true,
        }),
      });
    },
  }));
}

async function runWorldAction(
  o: ToolHost,
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
  o.service.assertCurrent(lease);
  if (
    state.terminal ||
    state.skipBatch ||
    (!background && !!o.attention?.pending)
  )
    throw new AgentRuntimeError('当前批次已停止。');
  if (
    o.memory.checkpoint.unknownEffect?.name === name &&
    ['chat', 'goto', 'follow'].includes(name)
  )
    throw new AgentRuntimeError(
      '上次聊天或移动结果未知，不能自动重放；请核对结果或等待玩家明确的新指令。',
    );

  o.memory.checkpoint.pi ??= {
    version: 2,
    taskId: lease.id,
    revision: lease.revision,
    taskStartedAt: lease.startedAt,
    audience: o.memory.task.current?.privateTo ?? 'public',
    messages: [],
  };
  o.memory.checkpoint.pi.inFlight = { id, name, state: 'executing' };
  await o.save();

  let known = false;
  try {
    const outcome = await executeTaskActions(
      o.session,
      [action],
      o.prepared().observation,
      o.config,
      signal,
      o.memory,
      o.budget,
      lease,
      () => o.save(),
      background ? undefined : o.attention,
      o.log,
    );
    o.prepared().observation = {
      ...outcome.observation,
      attention: o.message,
    };
    await o.observe();
    const { batch } = outcome;
    known = batch.stopReason !== 'unknown' && batch.stopReason !== 'executing';
    if (!batch.ok) {
      if (['goto', 'follow', 'edit', 'build', 'house'].includes(name))
        o.memory.effects.pendingEffects = batch;
      state.skipBatch = true;
      throw new AgentRuntimeError(JSON.stringify(batch));
    }
    if (name === 'follow' && o.memory.effects.follow) {
      o.service.finish(lease, {
        status: 'waiting',
        reason: '持续跟随中，由本地导航控制器推进。',
        waitFor: 'players',
        signature: worldSignature(o.prepared().observation, 'players'),
      });
      state.terminal = true;
    }
    if (['goto', 'follow', 'edit', 'build', 'house'].includes(name))
      state.turnMutated = true;
    return formatActionResult(
      action,
      batch,
      o.prepared().observation,
      o.memory,
    );
  } finally {
    if (o.service.current(lease) && !state.persistenceFailed) {
      if (known && o.memory.checkpoint.pi?.inFlight?.id === id)
        delete o.memory.checkpoint.pi.inFlight;
      await o.save();
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
  return result({
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
  });
}

async function launchBackgroundAction(
  o: ToolHost,
  input: {
    id: string;
    name: string;
    lease: TaskLease;
    controller: AbortController;
    work: Promise<unknown>;
  },
) {
  const { id, name, lease, controller, work } = input;
  o.memory.effects.activeAction = {
    id,
    name,
    taskId: lease.id,
    revision: lease.revision,
    status: 'running',
  };
  await o.save();
  const tracked = work
    .then(
      (value) => {
        if (o.service.current(lease))
          o.memory.effects.activeAction = {
            id,
            name,
            taskId: lease.id,
            revision: lease.revision,
            status: 'completed',
            result: value,
          };
      },
      (error) => {
        if (o.service.current(lease))
          o.memory.effects.activeAction = {
            id,
            name,
            taskId: lease.id,
            revision: lease.revision,
            status: o.activeSignal.aborted ? 'unknown' : 'failed',
            result: String(error),
          };
      },
    )
    .then(async () => {
      if (o.service.current(lease))
        recordEvent(o.memory, {
          id: `action:${id}`,
          kind: 'action_result',
          state: 'pending',
          at: Date.now(),
          audience: o.memory.task.current?.privateTo ?? 'public',
          taskId: lease.id,
          revision: lease.revision,
          actionId: id,
        });
      await o.save();
    });
  o.launch(id, controller, tracked);
  o.state.terminal = true;
  return result({ actionId: id, status: 'running' });
}
