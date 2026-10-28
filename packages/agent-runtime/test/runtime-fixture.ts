import {
  type AgentSession,
  type Observation,
  type Result,
  type RuntimeState,
} from '@voxel/agent-runtime';
import { AgentRunner } from '@voxel/agent-runtime/testing';
import { vi } from 'vitest';
import { newTask } from '../src/agent/task/state';
import { emptyState } from '../src/contracts/state';
import { AgentAttention } from '../src/world/observe/attention';

import type { Edit } from '@voxel/shared';
import { testAgentConfig } from '../../../tests/support/agent-config';
import { toolResponse } from '../../../tests/support/pi-response';

export function runtimeFixture(
  replies: { name: string; arguments: unknown }[][],
) {
  const config = {
    ...testAgentConfig({ apiKey: 'test-secret' }),
    permissions: { move: true, chat: true, place: true, remove: true },
    maxTurns: 12,
    timeoutMs: 1000,
    taskTimeoutMs: 10000,
  };
  const world: Observation = {
    id: 'o',
    revision: 1,
    radius: 8,
    self: {
      id: 'ai',
      name: 'AI',
      kind: 'ai-agent',
      connected: true,
      x: 0,
      y: 2.5,
      z: 0,
      yaw: 0,
    },
    players: [],
    blocks: [{ x: 1, y: 2, z: 0, material: 'stone' }],
    events: [],
    allowedActions: [],
  };
  const memory: RuntimeState = {
    version: 4 as const,
    character: { ...emptyState().character },
    execution: {
      ...emptyState().execution,
      task: { current: newTask('向东移动') },
    },
  };
  const attention = new AgentAttention();
  const session = {
    observe: vi.fn(async () => structuredClone(world)),
    move: vi.fn((x: number, z: number) => {
      world.self.x += x * 0.1;
      world.self.z += z * 0.1;
    }),
    request: vi.fn(
      async (type: string, input?: unknown): Promise<Observation | Result> => {
        const p = input as Edit;
        if (type === 'observe') return structuredClone(world);
        if (type === 'edit') {
          world.blocks = world.blocks.filter(
            (b) => b.x !== p.x || b.y !== p.y || b.z !== p.z,
          );
          if (p.material)
            world.blocks.push({ x: p.x, y: p.y, z: p.z, material: p.material });
          world.revision++;
        }
        return { ok: true, id: 'r', revision: world.revision };
      },
    ),
  };
  let index = 0;
  const request = vi.fn<typeof fetch>(async () =>
    toolResponse(
      replies[index++] ?? [
        {
          name: 'report_blocked',
          arguments: { reason: 'No more scripted responses' },
        },
      ],
    ),
  );
  const abort = new AbortController();
  const checkpoint = vi.fn(async () => {});
  const run = (defaults?: typeof config) =>
    new AgentRunner(undefined, request).run({
      session: {
        ...session,
        request: session.request as AgentSession['request'],
      },
      config,
      defaults,
      signal: abort.signal,
      memory,
      attention,
      checkpoint,
    });
  let sequence = 0;
  const message = (scope = 'private', actor = 'human', text = '你好') =>
    attention.push(
      {
        seq: ++sequence,
        at: Date.now(),
        type: 'chat',
        actor,
        actorKind: 'human',
        data: {
          scope,
          kind: 'text',
          text,
          name: 'Player',
          recipients: ['ai'],
        },
      },
      'ai',
    );
  return {
    config,
    world,
    memory,
    attention,
    session,
    request,
    abort,
    checkpoint,
    run,
    message,
  };
}
