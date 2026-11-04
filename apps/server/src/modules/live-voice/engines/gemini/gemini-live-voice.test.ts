import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { GeminiLiveVoice } from './gemini-live-voice';
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
  const session = new GeminiLiveVoice(
    {
      apiKey: 'secret',
      model: 'gemini-3.8-live',
      voice: 'Kore',
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
it('streams native audio, handles interruptions and forwards the agent result', () => {
  const t = setup();
  expect(t.sent()[0]).toMatchObject({
    setup: {
      model: 'models/gemini-3.8-live',
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
      },
    },
  });
  t.socket.message({ setupComplete: {} });
  t.session.sendAudio(Buffer.from([0, 1]));
  expect(t.sent().at(-1)).toEqual({
    realtimeInput: {
      audio: { data: 'AAE=', mimeType: 'audio/pcm;rate=16000' },
    },
  });
  t.socket.message({
    serverContent: {
      interrupted: true,
      modelTurn: {
        parts: [
          { inlineData: { data: 'AgM=', mimeType: 'audio/pcm;rate=24000' } },
        ],
      },
      inputTranscription: { text: '你好' },
    },
  });
  expect(t.events.interrupted).toHaveBeenCalledOnce();
  expect(t.events.audio).toHaveBeenCalledWith(Buffer.from([2, 3]), 24000);
  expect(t.events.transcript).toHaveBeenCalledWith('human', '你好');
  t.socket.message({
    serverContent: {
      outputTranscription: { text: '你好' },
      turnComplete: true,
    },
  });
  expect(t.events.transcript).toHaveBeenCalledWith('agent', '你好');
  expect(t.events.transcriptEnd).toHaveBeenCalledOnce();
  t.socket.message({
    toolCall: {
      functionCalls: [
        { id: 'd1', name: 'delegate_to_agent', args: { request: '建房' } },
      ],
    },
  });
  expect(t.events.delegation).toHaveBeenCalledWith('d1', '建房');
  t.session.deliverDelegation('d1', '开始执行');
  expect(t.sent().at(-1)).toEqual({
    toolResponse: {
      functionResponses: [
        {
          id: 'd1',
          name: 'delegate_to_agent',
          response: { result: '开始执行' },
        },
      ],
    },
  });
  t.session.close();
  expect(t.events.closed).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('ignores a late tool result after the provider cancels the call', () => {
  const t = setup();
  t.socket.message({ setupComplete: {} });
  t.socket.message({
    toolCall: {
      functionCalls: [
        { id: 'd1', name: 'delegate_to_agent', args: { request: '走路' } },
      ],
    },
  });
  t.socket.message({ toolCallCancellation: { ids: ['d1'] } });
  expect(t.events.cancelDelegation).toHaveBeenCalledWith('d1');
  const before = t.socket.send.mock.calls.length;
  t.session.deliverDelegation('d1', 'late');
  expect(t.socket.send).toHaveBeenCalledTimes(before);
  t.session.close();
});
