import type { Message } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { emptyState, type AgentRunState } from '../../contracts/state';
import { newTask } from '../task/state';
import { persistTranscript } from './transcript';

function memory(): AgentRunState {
  return {
    ...emptyState(),
    task: { current: newTask('goal') },
  };
}

/** One complete question/answer interaction. */
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

function persist(
  state: AgentRunState,
  options: {
    scope?: string;
    hasMessage?: boolean;
    attached?: boolean;
    apiKey?: string;
    text?: string;
  } = {},
) {
  const save = vi.fn(async () => {});
  return persistTranscript({
    memory: state,
    messages: transcript(options.text ?? 'hello'),
    scope: options.scope ?? 'public',
    hasMessage: options.hasMessage ?? true,
    attached: options.attached ?? false,
    apiKey: options.apiKey,
    save,
  });
}

describe('transcript persistence', () => {
  it('hides the configured key from every persisted copy', async () => {
    const state = memory();
    await persist(state, {
      scope: 'alice',
      apiKey: 'sk-secret',
      text: 'using sk-secret here',
    });
    const serialized = JSON.stringify(state.conversation.exchanges);
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).toContain('[已隐藏]');
  });

  it('keeps the newest private conversations and never expires public', async () => {
    const state = memory();
    await persist(state, { scope: 'public' });
    for (let i = 1; i <= 20; i++) await persist(state, { scope: `alice-${i}` });
    const keys = Object.keys(state.conversation.exchanges!);
    expect(keys).toContain('public');
    expect(keys).toContain('alice-20');
    expect(keys).not.toContain('alice-4');
    expect(keys.filter((key) => key !== 'public')).toHaveLength(16);
  });

  it('checkpoints a task turn but does not open a conversation', async () => {
    const state = memory();
    await persist(state, { hasMessage: false, attached: true });
    expect(state.conversation.exchanges).toBeUndefined();
    expect(state.checkpoint.pi?.messages).toEqual(transcript('hello'));
  });

  it('keeps a message turn out of the task checkpoint', async () => {
    const state = memory();
    await persist(state, { attached: false });
    expect(state.conversation.exchanges).toHaveProperty('public');
    expect(state.checkpoint.pi).toBeUndefined();
  });

  it('saves exactly once per persisted turn', async () => {
    const state = memory();
    const save = vi.fn(async () => {});
    await persistTranscript({
      memory: state,
      messages: transcript('hi'),
      scope: 'public',
      hasMessage: true,
      attached: false,
      save,
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
