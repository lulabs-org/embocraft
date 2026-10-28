import { describe, expect, it } from 'vitest';
import {
  emptyState,
  snapshotState,
  type AgentRunState,
} from '../contracts/state';
import { restoreState } from './migrate';

const persisted: AgentRunState = {
  version: 3,
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
    usage: {
      calls: 3,
      tokens: 600,
      estimated: false,
    },
  },
  conversation: {
    exchanges: {
      public: [{ speaker: 'Explorer', text: 'hello', reply: 'hi' }],
    },
    lastChatAt: 1700000000500,
  },
  checkpoint: {
    pi: {
      version: 1,
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
  inbox: { version: 1, events: [] },
};

describe('state persistence', () => {
  it('restores a partitioned v3 runtime and resets invalid archives to empty state', () => {
    const state = restoreState(persisted);
    expect(state).toEqual(persisted);
    expect(restoreState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(restoreState(undefined)).toEqual(emptyState());
    expect(restoreState('broken')).toEqual(emptyState());
    expect(restoreState({ version: 2 })).toEqual(emptyState());
  });

  it('keeps archived run snapshots free of character usage', () => {
    const state = restoreState(persisted);
    const snapshot = snapshotState(state);
    expect(snapshot.task.current?.goal).toBe('build house');
    expect(snapshot.task.usage).toBeUndefined();
    expect(state.task.usage).toBeDefined();
  });
});
