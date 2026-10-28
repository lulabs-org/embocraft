import type { AgentConfig, Observation } from '@voxel/agent-runtime';
import { testAgentConfig } from '../../../tests/support/agent-config';
import { characterPrompt } from '../src/agent/prompt/character';
import { turnInput } from '../src/agent/prompt/view';

export function buildMessages(
  o: Observation,
  previous: unknown,
  options: Partial<AgentConfig>,
) {
  const config = {
    ...testAgentConfig(),
    ...options,
  };
  return [
    { role: 'system', content: characterPrompt(config) },
    { role: 'user', content: JSON.stringify(turnInput(config, o, previous)) },
  ];
}

export function observation(): Observation {
  const self: Observation['self'] = {
    id: 'agent',
    name: 'Agent',
    kind: 'ai-agent',
    connected: true,
    x: 0,
    y: 3,
    z: 0,
    yaw: 0,
  };
  return {
    id: 'observation',
    revision: 7,
    radius: 8,
    allowedActions: ['observe'],
    self,
    players: Array.from({ length: 20 }, (_, i) => ({
      ...self,
      id: `player-${i}`,
    })),
    blocks: Array.from({ length: 510 }, (_, x) => ({
      x,
      y: 1,
      z: 0,
      material: 'wood',
    })),
    events: Array.from({ length: 20 }, (_, seq) => ({
      seq,
      type: 'chat',
      actor: 'human',
      actorKind: 'human',
      at: seq,
      data: { scope: 'private', recipients: ['agent'], text: `message-${seq}` },
    })),
  };
}

