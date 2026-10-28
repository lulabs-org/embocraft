import {
  type AgentAction,
  type AgentConfig,
  type ModelEndpoint,
  type Observation,
} from '@voxel/agent-runtime';

import { toolResponse } from './pi-response';

export type ToolCall = { name: string; arguments: unknown };
export type ModelResponder = (
  observation: Observation,
  previous: unknown,
  signal: AbortSignal,
) => Promise<ToolCall[]>;

/** Encode scripted model output only. All task policy, accounting and effects run in AgentRunner. */
export function modelRequest(
  respond: ModelResponder,
  tokens = 50,
): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(init!.body as string) as {
      messages: {
        role: string;
        content?: string | { type: string; text?: string }[];
      }[];
    };
    const user = [...body.messages]
      .reverse()
      .find((message) => message.role === 'user');
    const content = user!.content!;
    const payload = JSON.parse(
      typeof content === 'string'
        ? content
        : content.map((part) => part.text ?? '').join(''),
    );
    return toolResponse(
      await respond(payload.observation, payload.previous, init!.signal!),
      tokens,
    );
  };
}

export function scriptedModelFactory<T extends ModelEndpoint>(
  factory: (
    config: AgentConfig,
    provider: T,
  ) => { respond: ModelResponder; tokens?: number },
) {
  return (config: AgentConfig, provider: T) => {
    const { respond, tokens } = factory(config, provider);
    return { endpoint: provider, request: modelRequest(respond, tokens) };
  };
}

export function worldTool(action: AgentAction): ToolCall {
  const { type, ...args } = action;
  return { name: type, arguments: args };
}

export function testObservation(id = 'fixture-player'): Observation {
  return {
    id: 'observation',
    revision: 0,
    radius: 8,
    allowedActions: [],
    self: {
      id,
      name: 'Fixture',
      kind: 'ai-agent',
      connected: true,
      x: 0,
      y: 2.5,
      z: 0,
      yaw: 0,
    },
    players: [],
    blocks: [],
    events: [],
  };
}
