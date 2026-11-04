import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenAILiveVoice } from './openai-live-voice';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  terminate = vi.fn(() => this.emit('close'));
  ws() {
    return this as unknown as WebSocket;
  }
  message(data: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(data)), false);
  }
}
const setup = () => {
  vi.useFakeTimers();
  const socket = new Socket();
  const events = {
    ready: vi.fn(),
    audio: vi.fn(),
    interrupted: vi.fn(),
    transcript: vi.fn(),
    transcriptEnd: vi.fn(),
    delegation: vi.fn(),
    cancelDelegation: vi.fn(),
    error: vi.fn(),
    closed: vi.fn(),
  };
  const session = new OpenAILiveVoice(
    {
      apiKey: 'secret',
      model: 'gpt-live-1',
      voice: 'marin',
      instructions: 'Be helpful.',
      events,
    },
    () => socket.ws(),
  );
  socket.emit('open');
  const sent = () => socket.send.mock.calls.map(([v]) => JSON.parse(v));
  return { socket, events, session, sent };
};
afterEach(() => vi.useRealTimers());
it('streams audio and transcript events, delegates work, and closes cleanly', () => {
  const t = setup();
  expect(t.sent()[0]).toMatchObject({
    type: 'session.start',
    session: {
      model: 'gpt-live-1',
      audio: { format: { rate: 24000 }, output: { voice: 'marin' } },
      delegation: { type: 'client' },
    },
  });
  t.socket.message({ type: 'session.started' });
  t.session.sendAudio(Buffer.from([0, 1]));
  expect(t.sent().at(-1)).toEqual({
    type: 'session.input_audio.append',
    audio: 'AAE=',
  });
  t.socket.message({ type: 'session.output_audio.delta', delta: 'AgM=' });
  expect(t.events.audio).toHaveBeenCalledWith(Buffer.from([2, 3]), 24000);
  t.socket.message({ type: 'session.input_transcript.delta', delta: '你好' });
  expect(t.events.transcript).toHaveBeenCalledWith('human', '你好');
  t.socket.message({
    type: 'session.delegation.created',
    delegation: { id: 'd1', target: 'client' },
  });
  expect(t.events.delegation).toHaveBeenCalledWith('d1');
  t.session.deliverDelegation('d1', '已完成');
  expect(t.sent().at(-1)).toMatchObject({
    type: 'session.commentary.append',
    delegation_id: 'd1',
    content: '已完成',
  });
  t.session.close();
  expect(t.sent().at(-1).type).toBe('session.close');
  t.socket.message({ type: 'session.closed' });
  expect(t.events.closed).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('does not forward malformed audio or secret error details', () => {
  const t = setup();
  t.socket.message({ type: 'session.started' });
  t.socket.message({ type: 'session.output_audio.delta', delta: 'AA==' });
  expect(t.events.audio).not.toHaveBeenCalled();
  expect(t.events.error).toHaveBeenCalledOnce();
  expect(JSON.stringify(t.events.error.mock.calls)).not.toContain('secret');
  expect(t.events.closed).toHaveBeenCalledOnce();
});
