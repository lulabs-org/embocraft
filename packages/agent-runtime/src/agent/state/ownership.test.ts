import { describe, expect, it } from 'vitest';
import { emptyState, type AgentRunState } from '../../contracts/state';
import { newTask } from '../task/state';
import { characterState, composeState, taskExecutionState } from './ownership';

describe('character and execution ownership', () => {
  it('round-trips v3 state through disjoint scopes without sharing character data with task policy', () => {
    const state: AgentRunState = {
      ...emptyState(),
      task: {
        current: newTask('build'),
        identity: { id: 'task', revision: 2, startedAt: 123 },
        usage: { calls: 8, tokens: 400, estimated: false },
      },
      conversation: {
        exchanges: { public: ['hello'], alice: ['private'] },
        lastChatAt: 123,
        audienceExpired: true,
        lastReply: {
          actions: [],
          results: [],
          remaining: [],
          ok: true,
          stopReason: 'completed',
        },
      },
      checkpoint: {
        unknownEffect: { id: 'write', name: 'chat', state: 'unknown' },
      },
      effects: { previous: { ok: false } },
      health: { failures: 2 },
      inbox: { version: 1, events: [] },
    };
    const character = characterState(state);
    const execution = taskExecutionState(state);
    expect(character).toEqual({
      usage: state.task.usage,
      conversation: {
        exchanges: state.conversation.exchanges,
        lastChatAt: 123,
      },
      inbox: state.inbox,
    });
    expect(execution.task).not.toHaveProperty('usage');
    expect(execution.conversation).not.toHaveProperty('exchanges');
    expect(execution.conversation).not.toHaveProperty('lastChatAt');
    expect(execution).not.toHaveProperty('inbox');
    expect(composeState(character, execution)).toStrictEqual(state);
    expect(
      JSON.parse(JSON.stringify(composeState(character, execution))),
    ).toEqual(JSON.parse(JSON.stringify(state)));
  });

  it('keeps absent optional fields absent in an empty v3 state', () => {
    const state = emptyState();
    expect(
      composeState(characterState(state), taskExecutionState(state)),
    ).toStrictEqual(state);
  });
});
