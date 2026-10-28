import type { AgentTool } from '@earendil-works/pi-agent-core';
import { aiCharacterPermissions } from '@voxel/shared';
import { AgentRuntimeError } from '../../contracts/errors';
import { worldSignature } from '../../world/observe/extract';
import { executeTaskActions } from '../action/executor';
import { isActiveTask } from '../task/state';
import type { ToolHost } from './port';
import { taskToolSchemas } from './schema';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  details: {},
});

/**
 * Task outcome tools (complete_task, report_blocked, request_input, wait_for).
 * Settles the current task status on the host without routing through world tools.
 */
export function createTaskTools(o: ToolHost): AgentTool[] {
  return Object.entries(taskToolSchemas).map(([name, parameters]) => ({
    name,
    label: name,
    parameters,
    description: `Use ${name} for the current authorized activity. If no task exists, first call start_task(goal); a world tool never creates a task implicitly.`,
    execute: async (_id, value) => {
      const args = value as {
        condition: 'world' | 'players';
        reason: string;
        summary: string;
        question: string;
      };
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
      o.activeSignal.throwIfAborted();
      o.service.assertCurrent(lease);
      if (o.state.terminal || o.state.skipBatch || !!o.attention?.pending)
        throw new AgentRuntimeError('当前批次已停止。');
      if (name === 'wait_for')
        o.service.finish(lease, {
          status: 'waiting',
          waitFor: args.condition,
          reason: args.reason,
          signature: worldSignature(o.prepared().observation, args.condition),
        });
      else
        o.service.finish(
          lease,
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
        aiCharacterPermissions(o.config).chat &&
        o.memory.checkpoint.unknownEffect?.name !== 'chat'
      ) {
        const outcome = await executeTaskActions(
          o.session,
          [{ type: 'chat', text: args.question }],
          o.prepared().observation,
          o.config,
          o.activeSignal,
          o.memory,
          o.budget,
          lease,
          () => o.save(),
          o.attention,
          o.log,
        );
        o.prepared().observation = {
          ...outcome.observation,
          attention: o.message,
        };
        await o.observe();
      }
      return result({
        status: o.memory.task.current!.status,
        summary: o.memory.task.current!.summary,
      });
    },
  }));
}
