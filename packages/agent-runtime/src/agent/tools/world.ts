import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentAction } from '../../contracts';
import type { ToolHost } from './port';
import { worldToolSchemas } from './schema';

const syncDescription = (name: string) =>
  `Use ${name} for the current authorized activity. If no task exists, first call start_task(goal); a world tool never creates a task implicitly.`;

const backgroundDescription = (name: string) =>
  `Start ${name}; returns an action ID. Completion arrives as an action_result event. Never start a second action while one runs.`;

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
 * Forwards parsed tool parameters to the host without touching session or checkpoint internals.
 */
export function createRuntimeWorldTools(host: ToolHost): AgentTool[] {
  return [
    {
      name: 'observe',
      label: 'observe',
      parameters: worldToolSchemas.observe,
      description: syncDescription('observe'),
      execute: async () => result(await host.observeWorld()),
    },
    {
      name: 'chat',
      label: 'chat',
      parameters: worldToolSchemas.chat,
      description: syncDescription('chat'),
      execute: async (id, value) => {
        const { text, relatedToTask } = value as {
          text: string;
          relatedToTask?: boolean;
        };
        return result(
          await host.executeWorldAction(
            id,
            { type: 'chat', text },
            relatedToTask,
          ),
        );
      },
    },
    createWorldActionTool(host, 'goto', true),
    createWorldActionTool(host, 'follow', false),
    createWorldActionTool(host, 'edit', false),
    createWorldActionTool(host, 'build', true),
    createWorldActionTool(host, 'house', true),
  ];
}

function createWorldActionTool(
  host: ToolHost,
  name: 'goto' | 'follow' | 'edit' | 'build' | 'house',
  background: boolean,
): AgentTool {
  return {
    name,
    label: name,
    parameters: worldToolSchemas[name],
    description: background
      ? backgroundDescription(name)
      : syncDescription(name),
    execute: async (id, value) => {
      const action = {
        ...(value as Record<string, unknown>),
        type: name,
      } as AgentAction;
      return result(await host.executeWorldAction(id, action));
    },
  };
}
