import type { AgentTool } from '@earendil-works/pi-agent-core';
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
 * Forwards task settlement intents to the host without touching persistence internals.
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
        return result(
          await host.settleTask({ status: 'completed', reason: summary }),
        );
      },
    },
    {
      name: 'report_blocked',
      label: 'report_blocked',
      parameters: taskToolSchemas.report_blocked,
      description: description('report_blocked'),
      execute: async (_id, value) => {
        const { reason } = value as { reason: string };
        return result(await host.settleTask({ status: 'blocked', reason }));
      },
    },
    {
      name: 'request_input',
      label: 'request_input',
      parameters: taskToolSchemas.request_input,
      description: description('request_input'),
      execute: async (_id, value) => {
        const { question } = value as { question: string };
        return result(
          await host.settleTask(
            { status: 'needs_input', reason: question },
            question,
          ),
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
        return result(
          await host.settleTask({
            status: 'waiting',
            waitFor: condition,
            reason,
          }),
        );
      },
    },
  ];
}
