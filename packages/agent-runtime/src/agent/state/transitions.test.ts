import { describe, expect, it } from 'vitest';
import { emptyState } from '../../contracts/state';
import { restoreState } from '../../persistence/state';
import { newTask } from '../task/state';
import { resumeTaskState, startScheduledTaskState } from './transitions';

describe('host state transitions', () => {
  it('starts scheduled work with the same character data and the existing pacing reset', () => {
    const state = emptyState();
    state.character.usage = { calls: 4, tokens: 400, estimated: false };
    state.character.conversation = {
      exchanges: { public: ['hello'] },
      lastChatAt: 100,
    };
    state.execution.conversation.audienceExpired = true;
    state.character.inbox = { version: 1, events: [] };
    state.execution.effects.previous = { ok: false };
    const task = newTask('scheduled');

    const next = startScheduledTaskState(state, task);

    expect(next).not.toBe(state);
    expect(next.execution.task.current).toBe(task);
    expect(next.character.usage).toBe(state.character.usage);
    expect(next.character.conversation.exchanges).toBe(
      state.character.conversation.exchanges,
    );
    expect(next.character.inbox).toBe(state.character.inbox);
    expect(next.character.conversation.lastChatAt).toBeUndefined();
    expect(next.execution.conversation.audienceExpired).toBeUndefined();
    expect(next.execution.effects).toEqual({});
    expect(state.character.conversation.lastChatAt).toBe(100);
    expect(restoreState(JSON.parse(JSON.stringify(next)))).toEqual(next);
  });

  it('resumes current snapshots with historical conversations and current character usage', () => {
    const archived = emptyState();
    archived.execution.task.current = {
      ...newTask('paused'),
      status: 'paused',
      tokens: 123,
    };
    archived.execution.task.identity = {
      id: 'lease',
      revision: 2,
      startedAt: archived.execution.task.current.startedAt,
    };
    archived.character.usage = { calls: 1, tokens: 123, estimated: false };
    archived.character.conversation = {
      exchanges: { public: ['earlier'] },
      lastChatAt: 100,
    };
    archived.character.inbox = { version: 1, events: [] };
    archived.execution.checkpoint.unknownEffect = {
      id: 'unknown',
      name: 'goto',
      state: 'unknown',
    };
    const current = emptyState();
    current.character.usage = { calls: 20, tokens: 2000, estimated: false };
    current.character.conversation.exchanges = { public: ['newer'] };

    const next = resumeTaskState(current, archived);

    expect(next).toEqual({
      version: 4,
      character: { ...archived.character, usage: current.character.usage },
      execution: {
        ...archived.execution,
        task: { ...archived.execution.task },
      },
    });
    expect(next.character.usage).toBe(current.character.usage);
    expect(next.execution.task.current).toEqual(
      archived.execution.task.current,
    );
    expect(next.execution.task.identity).toEqual(
      archived.execution.task.identity,
    );
    next.character.conversation.exchanges!.public.push('resumed');
    next.execution.checkpoint.unknownEffect!.name = 'edited';
    expect(archived.character.conversation.exchanges!.public).toEqual([
      'earlier',
    ]);
    expect(archived.execution.checkpoint.unknownEffect!.name).toBe('goto');
    expect(current.character.conversation.exchanges!.public).toEqual(['newer']);
  });
});
