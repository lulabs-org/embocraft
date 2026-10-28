import type { AgentTool } from '@earendil-works/pi-agent-core';
import { aiCharacterPermissions } from '@voxel/shared';
import { AgentRuntimeError } from '../../contracts/errors';
import { worldSignature } from '../../world/observe/extract';
import { executeTaskActions } from '../action/executor';
import type { TaskLease, TaskOutcome } from '../task/service';
import { isActiveTask } from '../task/state';
import type { ToolHost } from './port';
import { taskToolSchemas } from './schema';

const description = (name: string) =>
  `Use ${name} for the current authorized activity. If no task exists, first call start_task(goal); a world tool never creates a task implicitly.`;

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  details: {},
});

/**
 * Task outcome tools (complete_task, report_blocked, request_input, wait_for).
 * Settles the current task status on the host without routing through world tools.
 */
export function createTaskTools(host: ToolHost): AgentTool[] {
  return [
    {
      name: 'complete_task',
      label: 'complete_task',
      parameters: taskToolSchemas.complete_task,
      description: description('complete_task'),
      execute: async (_id, value) => {
        const { summary } = value as { summary: string };
        return settleTask(host, { status: 'completed', reason: summary });
      },
    },
    {
      name: 'report_blocked',
      label: 'report_blocked',
      parameters: taskToolSchemas.report_blocked,
      description: description('report_blocked'),
      execute: async (_id, value) => {
        const { reason } = value as { reason: string };
        return settleTask(host, { status: 'blocked', reason });
      },
    },
    {
      name: 'request_input',
      label: 'request_input',
      parameters: taskToolSchemas.request_input,
      description: description('request_input'),
      execute: async (_id, value) => {
        const { question } = value as { question: string };
        return settleTask(
          host,
          { status: 'needs_input', reason: question },
          question,
        );
      },
    },
    {
      name: 'wait_for',
      label: 'wait_for',
      parameters: taskToolSchemas.wait_for,
      description: description('wait_for'),
      execute: async (_id, value) => {
        const { condition, reason } = value as {
          condition: 'world' | 'players';
          reason: string;
        };
        const lease = claimActiveTaskLease(host);
        return commitTaskOutcome(host, lease, {
          status: 'waiting',
          waitFor: condition,
          reason,
          signature: worldSignature(host.prepared().observation, condition),
        });
      },
    },
  ];
}

async function settleTask(
  host: ToolHost,
  outcome: Exclude<TaskOutcome, { status: 'waiting' }>,
  questionToAsk?: string,
) {
  const lease = claimActiveTaskLease(host);
  return commitTaskOutcome(host, lease, outcome, questionToAsk);
}

function claimActiveTaskLease(host: ToolHost): TaskLease {
  host.authorize();
  if (host.actionBusy())
    throw new AgentRuntimeError('当前动作尚未结束，请读取进度或先明确停止。');
  if (!isActiveTask(host.memory.task.current))
    throw new AgentRuntimeError(
      'No active running task. For a NEW human action request, call start_task(goal) FIRST, then retry the world tool. Do not claim completion: no world action was executed. A paused or exhausted task must be resumed, never recreated.',
    );
  host.attach();
  const lease = host.service.lease();
  host.activeSignal.throwIfAborted();
  host.service.assertCurrent(lease);
  if (host.state.terminal || host.state.skipBatch || !!host.attention?.pending)
    throw new AgentRuntimeError('当前批次已停止。');
  return lease;
}

async function commitTaskOutcome(
  host: ToolHost,
  lease: TaskLease,
  outcome: TaskOutcome,
  questionToAsk?: string,
) {
  host.service.finish(lease, outcome, host.state.turnMutated);
  host.state.terminal = true;
  await host.save();
  if (
    questionToAsk &&
    aiCharacterPermissions(host.config).chat &&
    host.memory.checkpoint.unknownEffect?.name !== 'chat'
  ) {
    const chatOutcome = await executeTaskActions(
      host.session,
      [{ type: 'chat', text: questionToAsk }],
      host.prepared().observation,
      host.config,
      host.activeSignal,
      host.memory,
      host.budget,
      lease,
      () => host.save(),
      host.attention,
      host.log,
    );
    host.prepared().observation = {
      ...chatOutcome.observation,
      attention: host.message,
    };
    await host.observe();
  }
  return result({
    status: host.memory.task.current!.status,
    summary: host.memory.task.current!.summary,
  });
}
