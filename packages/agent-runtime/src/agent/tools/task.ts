import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentAction, BatchResult } from '../../contracts';
import { AgentRuntimeError } from '../../contracts/errors';
import { houseBlocks } from '../../world/actions/build';
import { observedEmpty } from '../../world/observe/verify';
import type { AgentRunState } from '../../contracts/state';
import { TaskService, type TaskLease } from '../task/service';
import type { DecisionContext } from '../../contracts/observation';
import type { ToolState } from '../../contracts/tool-state';
import { toolSchemas } from './schema';
import { worldSignature, worldView } from '../../world/observe/extract';

/** Task-only tools. World effects are injected; no task creation or conversation mode. */
export function createTaskTools(o: {
  state: ToolState;
  memory: AgentRunState;
  service: TaskService;
  lease: TaskLease;
  prepared: () => DecisionContext;
  observe: () => Promise<void>;
  canChat: boolean;
  signal: AbortSignal;
  save: () => Promise<void>;
  shouldYield: () => boolean;
  execute: (action: AgentAction) => Promise<BatchResult>;
}): AgentTool[] {
  const result = (value: unknown) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, (key, value) =>
          key === 'batchId' ? undefined : value,
        ),
      },
    ],
    details: {},
  });
  return Object.entries(toolSchemas).map(([name, parameters]) => ({
    name,
    label: name,
    parameters,
    description:
      name === 'complete_task'
        ? 'Complete only after prior results confirm the goal.'
        : `Execute ${name} for the current task.`,
    execute: async (id, value) => {
      const args = value as Record<string, unknown> & {
        condition: 'world' | 'players';
        reason: string;
        summary: string;
        question: string;
      };
      o.signal.throwIfAborted();
      o.service.assertCurrent(o.lease);
      if (o.state.terminal || o.state.skipBatch || o.shouldYield())
        throw new AgentRuntimeError('当前批次已停止。');
      if (
        o.memory.checkpoint.unknownEffect?.name === name &&
        ['chat', 'move', 'goto', 'follow'].includes(name)
      )
        throw new AgentRuntimeError(
          '上次聊天或移动结果未知，不能自动重放；请核对结果或等待玩家明确的新指令。',
        );
      if (name === 'observe') {
        await o.observe();
        return result({
          observation: worldView(o.prepared().observation),
          unfinishedBuild: o.memory.effects.unfinishedBuild,
        });
      }
      if (
        [
          'complete_task',
          'report_blocked',
          'request_input',
          'wait_for',
        ].includes(name)
      ) {
        if (name === 'wait_for')
          o.service.finish(o.lease, {
            status: 'waiting',
            waitFor: args.condition,
            reason: args.reason,
            signature: worldSignature(o.prepared().observation, args.condition),
          });
        else
          o.service.finish(
            o.lease,
            {
              status:
                name === 'complete_task'
                  ? 'completed'
                  : name === 'request_input'
                    ? 'needs_input'
                    : 'blocked',
              reason: args.summary ?? args.question ?? args.reason,
            },
            o.state.turnMutated,
          );
        o.state.terminal = true;
        await o.save();
        if (
          name === 'request_input' &&
          o.canChat &&
          o.memory.checkpoint.unknownEffect?.name !== 'chat'
        ) {
          // The host executor enforces the task audience and current chat permission.
          await o.execute({ type: 'chat', text: args.question });
        }
        return result({
          status: o.memory.task.current!.status,
          summary: o.memory.task.current!.summary,
        });
      }
      const action = { ...args, type: name } as AgentAction;
      o.memory.checkpoint.pi ??= {
        version: 2,
        taskId: o.lease.id,
        revision: o.lease.revision,
        taskStartedAt: o.lease.startedAt,
        audience: o.memory.task.current?.privateTo ?? 'public',
        messages: [],
      };
      o.memory.checkpoint.pi.inFlight = { id, name, state: 'executing' };
      await o.save();
      let known = false;
      try {
        const batch = await o.execute(action);
        known =
          batch.stopReason !== 'unknown' && batch.stopReason !== 'executing';
        if (!batch.ok) {
          if (
            ['move', 'goto', 'follow', 'edit', 'build', 'house'].includes(name)
          )
            o.memory.effects.pendingEffects = batch;
          o.state.skipBatch = true;
          throw new AgentRuntimeError(JSON.stringify(batch));
        }
        if (name === 'follow' && o.memory.effects.follow) {
          o.service.finish(o.lease, {
            status: 'waiting',
            reason: '持续跟随中，由本地导航控制器推进。',
            waitFor: 'players',
            signature: worldSignature(o.prepared().observation, 'players'),
          });
          o.state.terminal = true;
        }
        if (['move', 'goto', 'follow', 'edit', 'build', 'house'].includes(name))
          o.state.turnMutated = true;
        const edits =
          action.type === 'edit'
            ? [action]
            : action.type === 'build'
              ? action.blocks
              : action.type === 'house'
                ? houseBlocks(action)
                : [];
        const observation = o.prepared().observation;
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
          unfinishedBuild: o.memory.effects.unfinishedBuild,
        });
      } finally {
        if (o.service.current(o.lease) && !o.state.persistenceFailed) {
          if (known && o.memory.checkpoint.pi?.inFlight?.id === id)
            delete o.memory.checkpoint.pi.inFlight;
          await o.save();
        }
      }
    },
  }));
}
