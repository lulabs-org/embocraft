import { describe, expect, it } from 'vitest';
import {
  emptyState,
  snapshotState,
  type RuntimeState,
} from '../contracts/state';
import { restoreState } from './state';

const persisted: RuntimeState = {
  version: 4 as const,
  character: {
    usage: {
      calls: 3,
      tokens: 600,
      estimated: false,
    },
    conversation: {
      exchanges: {
        public: [{ speaker: 'Explorer', text: 'hello', reply: 'hi' }],
      },
      lastChatAt: 1700000000500,
    },
    inbox: { version: 1, events: [] },
  },
  execution: {
    task: {
      current: {
        goal: 'build house',
        status: 'running',
        summary: '',
        reason: '',
        calls: 3,
        tokens: 600,
        estimated: false,
        startedAt: 1700000000000,
        elapsedMs: 500,
      },
      identity: {
        id: 'lease-1',
        revision: 2,
        startedAt: 1700000000000,
      },
    },
    conversation: {},
    checkpoint: {
      pi: {
        taskId: 'fixture',
        revision: 0,
        version: 3,
        taskStartedAt: 1700000000000,
        audience: 'public',
        messages: [],
        inFlight: { id: 'tool-1', name: 'move', state: 'executing' },
      },
    },
    effects: {
      previous: { ok: true },
      pendingEffects: {
        actions: [{ type: 'wait' }],
        results: [{ action: { type: 'wait' }, status: 'executing' }],
        remaining: [],
        ok: false,
        stopReason: 'executing',
      },
    },
    health: {
      waitSignature: '[]',
      failures: 2,
      noProgress: 1,
      lastResponse: '收到',
    },
  },
};

describe('state persistence', () => {
  it('round-trips current archives without sharing mutable state', () => {
    const state = restoreState(persisted);
    expect(state).toEqual(persisted);
    expect(restoreState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(restoreState(undefined)).toEqual(emptyState());
    state.character.conversation.lastChatAt = 0;
    expect(persisted.character.conversation.lastChatAt).not.toBe(0);
  });

  it('keeps archived run snapshots free of character usage', () => {
    const state = restoreState(persisted);
    const snapshot = snapshotState(state);
    expect(snapshot.execution.task.current?.goal).toBe('build house');
    expect(snapshot.character.usage).toBeUndefined();
    expect(state.character.usage).toBeDefined();
  });
});

it.each([
  null,
  'broken',
  { version: 2 },
  {
    version: 3,
    task: {},
    conversation: {},
    checkpoint: {},
    effects: {},
    health: {},
  },
])(
  'rejects unsupported archives instead of silently dropping them: %j',
  (raw) => {
    expect(() => restoreState(raw)).toThrow('存档格式不受支持');
  },
);

it('rejects damaged current partitions and unsupported checkpoints', () => {
  expect(() =>
    restoreState({ version: 4, character: {}, execution: {} }),
  ).toThrow('分区');
  const state = structuredClone(persisted);
  expect(() =>
    restoreState({
      ...state,
      execution: { ...state.execution, checkpoint: { pi: { version: 2 } } },
    }),
  ).toThrow('检查点');
});
