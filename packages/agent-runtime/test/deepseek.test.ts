import {
  executeAction,
  parseAction,
  type Observation,
  type Session,
} from '@voxel/agent-runtime';
import { nextIntervalMs } from '../src/agent/schedule';

import { describe, expect, it, vi } from 'vitest';
import { testAgentConfig } from '../../../tests/support/agent-config';

const config = () => ({
  ...testAgentConfig({ apiKey: 'test-key' }),
  intervalMs: 0,
  timeoutMs: 200,
});
const observation: Observation = {
  id: 'obs',
  revision: 94,
  radius: 8,
  allowedActions: ['move', 'chat', 'edit', 'observe'],
  self: {
    id: 'a',
    name: 'DeepSeek',
    kind: 'ai-agent',
    connected: true,
    x: 0,
    y: 2.5,
    z: 0,
    yaw: 0,
  },
  blocks: [],
  players: [],
  events: [],
};
const signal = () => new AbortController().signal;
describe('DeepSeek agent boundary', () => {
  it.each([
    null,
    [],
    { type: 'shell', command: 'rm -rf /' },
    { type: 'move', x: 99, z: 0, jump: false, durationMs: 100 },
    { type: 'move', x: 0, z: 0, jump: false, durationMs: 5000 },
    { type: 'move', x: NaN, z: 0, jump: false, durationMs: 100 },
    { type: 'chat', text: 'x'.repeat(241) },
    { type: 'edit', x: 0, y: 0, z: 0, material: null },
    { type: 'edit', x: 1, y: 3, z: 0, material: ['wood'] },
  ])('rejects untrusted action %j', (value) => {
    expect(() =>
      parseAction(value, { move: true, chat: true, place: true, remove: true }),
    ).toThrow();
  });
  it('enforces edit opt-in even for otherwise valid edits', () => {
    expect(() =>
      parseAction(
        { type: 'edit', x: 1, y: 3, z: 0, material: 'wood' },
        { move: true, chat: true, place: false, remove: false },
      ),
    ).toThrow('未开启');
    expect(
      parseAction(
        { type: 'wait', command: 'ignored' },
        { move: true, chat: true, place: false, remove: false },
      ),
    ).toEqual({
      type: 'wait',
    });
  });
});
describe('AI action execution', () => {
  function session() {
    return {
      move: vi.fn(),
      request: vi
        .fn()
        .mockResolvedValue({ ok: false, error: 'conflict', revision: 95 }),
      observe: vi.fn().mockResolvedValue(observation),
    };
  }
  it('uses observed revision for edits and returns server conflicts without replaying', async () => {
    const s = session();
    const result = await executeAction(
      s as unknown as Session,
      { type: 'edit', x: 1, y: 3, z: 0, material: 'wood' },
      observation,
      { move: true, chat: true, place: true, remove: true },
      signal(),
    );
    expect(s.request).toHaveBeenCalledExactlyOnceWith('edit', {
      x: 1,
      y: 3,
      z: 0,
      material: 'wood',
      revision: 94,
    });
    expect(result).toMatchObject({ ok: false, error: 'conflict' });
    await expect(
      executeAction(
        s as unknown as Session,
        { type: 'edit', x: 1, y: 3, z: 0, material: null },
        observation,
        { move: true, chat: true, place: false, remove: false },
        signal(),
      ),
    ).rejects.toThrow('未开启');
  });
  it('stops movement on cancellation', async () => {
    const s = session(),
      abort = new AbortController();
    const moving = executeAction(
      s as unknown as Session,
      { type: 'move', x: 1, z: 0, jump: false, durationMs: 1000 },
      observation,
      { move: true, chat: true, place: false, remove: false },
      abort.signal,
    );
    abort.abort();
    await expect(moving).rejects.toThrow();
    expect(s.move.mock.calls).toEqual([
      [1, 0, false],
      [0, 0, false],
    ]);
  });
});

describe('bounded and randomized scheduling', () => {
  it('samples inclusive random bounds and preserves fixed intervals', () => {
    const cfg = {
      ...config(),
      intervalMode: 'random' as const,
      intervalMinMs: 4000,
      intervalMaxMs: 8000,
    };
    expect(nextIntervalMs(cfg, () => 0)).toBe(4000);
    expect(nextIntervalMs(cfg, () => 0.999999)).toBe(8000);
    expect(nextIntervalMs(cfg, () => 0.5)).toBe(6000);
    expect(
      nextIntervalMs({ ...cfg, intervalMinMs: 5000, intervalMaxMs: 5000 }),
    ).toBe(5000);
    expect(
      nextIntervalMs(
        { ...cfg, intervalMode: 'fixed', intervalMs: 3000 },
        () => 0.5,
      ),
    ).toBe(3000);
  });
});
