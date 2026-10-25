import type { AgentTool } from '@earendil-works/pi-agent-core';
import { AgentRuntimeError } from '../../contracts/errors';
import type { TaskCommand } from '../task/service';
import { conversationToolSchemas } from './schema';
import type { ToolHost } from './port';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  details: {},
});

/**
 * Creates conversation-scoped task control tools (reply, start_task, revise_task,
 * etc.) that let the model manage high-level activities without invoking world
 * actions directly. Configuration switching and commit bookkeeping live on the
 * host so a handler only forwards the player's intent.
 */
export function createTaskControlTools(o: ToolHost): AgentTool[] {
  return Object.entries(conversationToolSchemas).map(([name, parameters]) => ({
    name,
    label: name,
    parameters,
    description:
      name === 'reply'
        ? 'Reply to the current human message without changing the activity.'
        : 'Control the current activity, preserving its identity and spent budget. After start or revise, use world tools in this same session.',
    execute: async (_id, value) => {
      const args = value as {
        text?: string;
        goal?: string;
        reply?: string;
        relatedToTask?: boolean;
      };
      if (name === 'reply') {
        await o.respond(args.text!, args.relatedToTask);
        return result({ replied: true });
      }
      if (!o.message) throw new AgentRuntimeError('任务控制需要明确玩家指令。');
      o.authorize();
      const command = {
        type: name.replace('_task', ''),
        goal: args.goal,
      } as TaskCommand;
      await o.commitTask(command, args.reply);
      return result({ task: o.memory.task.current });
    },
  }));
}
