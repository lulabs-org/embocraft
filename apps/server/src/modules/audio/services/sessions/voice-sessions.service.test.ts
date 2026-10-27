import { expect, it, vi } from 'vitest';
import { VoiceSessions } from './voice-sessions.service';
import type { VoiceProvider, VoiceSession } from '../../domain/types';

function fixture() {
  const opened: VoiceSession[] = [];
  const provider: VoiceProvider = {
    id: 'fixture',
    create: vi.fn((emit) => {
      const session = {
        push: vi.fn(() =>
          emit({
            provider: 'fixture',
            state: 'listening',
            turn: 1,
            subtitle: 'ready',
          }),
        ),
        interrupt: vi.fn(),
        close: vi.fn(),
      };
      opened.push(session);
      return session;
    }),
  };
  const select = vi.fn(() => provider);
  return {
    opened,
    provider,
    select,
    sessions: new VoiceSessions(() => provider, select),
  };
}

it('validates text before replacing a session and preserves request IDs and untrimmed input', () => {
  const { sessions, opened, provider } = fixture();
  const emit = vi.fn();
  expect(
    sessions.start('a', 'first', { text: ' hello ' }, emit),
  ).toBeUndefined();
  expect(opened[0].push).toHaveBeenCalledWith({
    kind: 'text',
    text: ' hello ',
  });
  expect(emit).toHaveBeenCalledWith({
    requestId: 'first',
    provider: 'fixture',
    state: 'listening',
    turn: 1,
    subtitle: 'ready',
  });
  for (const payload of [
    undefined,
    {},
    { text: ' ' },
    { text: 'x'.repeat(241) },
  ])
    expect(sessions.start('a', 'invalid', payload, emit)).toBe(
      'invalid-voice-input',
    );
  expect(opened[0].close).not.toHaveBeenCalled();
  expect(provider.create).toHaveBeenCalledTimes(1);
  expect(sessions.start('a', 'next', { text: 'next' }, emit)).toBeUndefined();
  expect(opened[0].close).toHaveBeenCalledOnce();
  expect(emit.mock.calls.at(-1)![0].requestId).toBe('next');
  sessions.dispose();
});

it('closes a previous session before a provider selection failure and preserves error frames', () => {
  const { sessions, opened, select } = fixture();
  const emit = vi.fn();
  sessions.start('a', 'first', { text: 'hello' }, emit);
  expect(
    sessions.start('a', 'bad', { text: 'hello', provider: 123 }, emit),
  ).toBe('voice-provider-unavailable');
  expect(opened[0].close).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
  expect(emit.mock.calls.at(-1)![0]).toEqual({
    requestId: 'bad',
    provider: 123,
    state: 'error',
    turn: 0,
    subtitle: '无效语音方案。',
  });
  select.mockImplementation(() => {
    throw Error('provider failed');
  });
  expect(
    sessions.start('a', 'failed', { text: 'hello', provider: 'missing' }, emit),
  ).toBe('voice-provider-unavailable');
  expect(emit.mock.calls.at(-1)![0].subtitle).toBe('provider failed');
  sessions.close('a');
  expect(opened[0].close).toHaveBeenCalledOnce();
});

it('isolates owner interruption and closes remaining sessions once on disposal', () => {
  const { sessions, opened, select } = fixture();
  sessions.start('a', 'one', { text: 'hello', provider: 'selected' }, () => {});
  sessions.start('b', 'two', { text: 'hello' }, () => {});
  expect(select).toHaveBeenCalledWith('selected');
  sessions.interrupt('a');
  sessions.interrupt('missing');
  expect(opened[0].interrupt).toHaveBeenCalledOnce();
  expect(opened[1].interrupt).not.toHaveBeenCalled();
  sessions.close('a');
  sessions.close('a');
  sessions.dispose();
  sessions.dispose();
  for (const session of opened) expect(session.close).toHaveBeenCalledOnce();
});
