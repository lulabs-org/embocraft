import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TaskCommand } from '../../contracts/task';
import type { ToolHost } from './port';
import { conversationToolSchemas } from './schema';

const TASK_CONTROL_DESCRIPTION =
  'Control the current activity, preserving its identity and spent budget. After start or revise, use world tools in this same session.';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  details: {},
});

/**
 * Conversation-scoped tools for handling a player's chat message:
 * - `reply`: answers a casual message without changing the current task.
 * - `start_task` / `revise_task` / `pause_task` / `resume_task` / `cancel_task`:
 *   applies a player's task command and optionally replies in chat.
 */
export function createTaskControlTools(host: ToolHost): AgentTool[] {
  return [
    {
      name: 'reply',
      label: 'reply',
      parameters: conversationToolSchemas.reply,
      description:
        'Reply to the current human message without changing the activity.',
      execute: async (_id, value) => {
        const { text, relatedToTask } = value as {
          text: string;
          relatedToTask?: boolean;
        };
        await host.respond(text, relatedToTask);
        return result({ replied: true });
      },
    },
    createGoalTaskTool(host, 'start_task', 'start'),
    createGoalTaskTool(host, 'revise_task', 'revise'),
    createSimpleTaskTool(host, 'pause_task', 'pause'),
    createSimpleTaskTool(host, 'resume_task', 'resume'),
    createSimpleTaskTool(host, 'cancel_task', 'cancel'),
  ];
}

function createGoalTaskTool(
  host: ToolHost,
  name: 'start_task' | 'revise_task',
  type: 'start' | 'revise',
): AgentTool {
  return {
    name,
    label: name,
    parameters: conversationToolSchemas[name],
    description: TASK_CONTROL_DESCRIPTION,
    execute: async (_id, value) => {
      const { goal, reply } = value as { goal: string; reply?: string };
      return executePlayerTaskCommand(host, { type, goal }, reply);
    },
  };
}

function createSimpleTaskTool(
  host: ToolHost,
  name: 'pause_task' | 'resume_task' | 'cancel_task',
  type: 'pause' | 'resume' | 'cancel',
): AgentTool {
  return {
    name,
    label: name,
    parameters: conversationToolSchemas[name],
    description: TASK_CONTROL_DESCRIPTION,
    execute: async (_id, value) => {
      const { reply } = value as { reply?: string };
      return executePlayerTaskCommand(host, { type }, reply);
    },
  };
}

async function executePlayerTaskCommand(
  host: ToolHost,
  command: TaskCommand,
  reply?: string,
) {
  const task = await host.commitTask(command, reply);
  return result({ task });
}
