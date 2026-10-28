import { describe, expect, it } from 'vitest';
import { emptyState } from '../contracts/state';
import { newTask } from '../agent/task/state';
import { restoreState } from '../persistence/migrate';
import { resumeTaskState, startScheduledTaskState } from './state';

describe('host state transitions', () => {
  it('starts scheduled work with the same character data and the existing pacing reset', () => {
    const state = emptyState();
    state.task.usage = { calls: 4, tokens: 400, estimated: false };
    state.conversation = {
      exchanges: { public: ['hello'] },
      lastChatAt: 100,
      audienceExpired: true,
    };
    state.inbox = { version: 1, events: [] };
    state.effects.previous = { ok: false };
    const task = newTask('scheduled');

    const next = startScheduledTaskState(state, task);

    expect(next).not.toBe(state);
    expect(next.task.current).toBe(task);
    expect(next.task.usage).toBe(state.task.usage);
    expect(next.conversation.exchanges).toBe(state.conversation.exchanges);
    expect(next.inbox).toBe(state.inbox);
    expect(next.conversation.lastChatAt).toBeUndefined();
    expect(next.conversation.audienceExpired).toBeUndefined();
    expect(next.effects).toEqual({});
    expect(state.conversation.lastChatAt).toBe(100);
    expect(restoreState(JSON.parse(JSON.stringify(next)))).toEqual(next);
  });

  it('resumes v3 snapshots with historical conversations and current character usage', () => {
    const archived = emptyState();
    archived.task.current = {
      ...newTask('paused'),
      status: 'paused',
      tokens: 123,
    };
    archived.task.identity = {
      id: 'lease',
      revision: 2,
      startedAt: archived.task.current.startedAt,
    };
    archived.task.usage = { calls: 1, tokens: 123, estimated: false };
    archived.conversation = {
      exchanges: { public: ['earlier'] },
      lastChatAt: 100,
    };
    archived.inbox = { version: 1, events: [] };
    archived.checkpoint.unknownEffect = {
      id: 'unknown',
      name: 'goto',
      state: 'unknown',
    };
    const current = emptyState();
    current.task.usage = { calls: 20, tokens: 2000, estimated: false };
    current.conversation.exchanges = { public: ['newer'] };

    const next = resumeTaskState(current, archived);

    expect(next).toEqual({
      ...archived,
      task: { ...archived.task, usage: current.task.usage },
    });
    expect(next.task.usage).toBe(current.task.usage);
    expect(next.task.current).toBe(archived.task.current);
    expect(next.task.identity).toBe(archived.task.identity);
    next.conversation.exchanges!.public.push('resumed');
    next.checkpoint.unknownEffect!.name = 'edited';
    expect(archived.conversation.exchanges!.public).toEqual(['earlier']);
    expect(archived.checkpoint.unknownEffect!.name).toBe('goto');
    expect(current.conversation.exchanges!.public).toEqual(['newer']);
  });
});
