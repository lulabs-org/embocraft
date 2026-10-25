import type { Message } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { emptyState, type AgentRunState } from '../../contracts/state';
import { newTask } from '../task/state';
import { restoreCheckpoint } from './checkpoint';
import { persistTranscript } from './transcript';

function memory(): AgentRunState {
  return { ...emptyState(), task: { current: newTask('goal') } };
}

function transcript(text: string): Message[] {
  return [
    { role: 'user', content: `ask ${text}`, timestamp: 1 },
    {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text }],
      timestamp: 2,
    } as Message,
  ];
}

describe('checkpoint restoration', () => {
  it('restores a checkpoint owned by the current task revision', async () => {
    const state = memory();
    await persistTranscript({
      memory: state,
      messages: transcript('hello'),
      scope: 'public',
      hasMessage: false,
      attached: true,
      save: async () => {},
    });
    restoreCheckpoint(state);
    expect(state.checkpoint.pi?.messages).toEqual(transcript('hello'));
  });

  it('drops a checkpoint from another task revision', () => {
    const state = memory();
    state.checkpoint.pi = {
      version: 3,
      taskId: 'other',
      revision: 1,
      taskStartedAt: state.task.current!.startedAt,
      audience: 'public',
      messages: [],
    };
    restoreCheckpoint(state);
    expect(state.checkpoint.pi).toBeUndefined();
  });

  it('turns an in-flight tool call into an unknown effect', () => {
    const state = memory();
    state.checkpoint.pi = {
      version: 3,
      taskId: 'x',
      revision: 0,
      taskStartedAt: state.task.current!.startedAt,
      audience: 'public',
      messages: [],
      inFlight: { id: 'call', name: 'edit', state: 'executing' },
    };
    restoreCheckpoint(state);
    expect(state.checkpoint.unknownEffect).toEqual({
      id: 'call',
      name: 'edit',
      state: 'unknown',
    });
  });
});
