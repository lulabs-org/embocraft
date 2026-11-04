import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import {
  LiveVoiceStore,
  type SavedLiveVoice,
} from '../services/live-voice-store';
import type { LiveVoiceEvents, LiveVoiceSession } from '../ports';
import { LiveVoiceSockets } from './live-voice.socket';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.emit('close');
  });
  ws() {
    return this as unknown as WebSocket;
  }
  message(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
}
const request = {
  headers: { origin: 'http://localhost:5173' },
} as IncomingMessage;
async function setup() {
  vi.useFakeTimers();
  let stored: SavedLiveVoice[] = [];
  const store = new LiveVoiceStore({
    load: async () => stored,
    save: async (next) => {
      stored = structuredClone(next);
    },
  });
  await store.load();
  const service = await store.save({
    provider: 'gemini',
    model: 'gemini-3.8-live',
    name: 'Live',
    voice: 'Kore',
    apiKey: 'secret',
  });
  let valid = true;
  const delegated = vi.fn(
    async (_text: string, _signal: AbortSignal) => 'Agent 已答复',
  );
  const publishTranscript = vi.fn();
  const publishHumanTranscript = vi.fn();
  const authorize = vi.fn((token: string, agentId: string) => {
    if (token !== 'valid') throw new Error('invalid');
    return {
      actorId: 'human',
      agentId,
      serviceId: service.id,
      instructions: 'role',
      valid: () => valid,
      delegate: delegated,
      publishTranscript,
      publishHumanTranscript,
    };
  });
  let events!: LiveVoiceEvents;
  const provider: LiveVoiceSession = {
    inputSampleRate: 16000,
    sendAudio: vi.fn(),
    updateContext: vi.fn(),
    deliverDelegation: vi.fn(),
    close: vi.fn(),
  };
  const factory = vi.fn((_settings, options) => {
    events = options.events;
    return provider;
  });
  const server = new LiveVoiceSockets(
    store,
    authorize,
    'http://localhost:5173',
    factory,
  );
  const connect = () => {
    const socket = new Socket();
    server.handle(socket.ws(), request);
    return socket;
  };
  return {
    connect,
    store,
    service,
    factory,
    provider,
    delegated,
    publishTranscript,
    publishHumanTranscript,
    get events() {
      return events;
    },
    invalidate: () => {
      valid = false;
    },
  };
}
afterEach(() => vi.useRealTimers());
it('validates the player and agent, streams audio, delegates requests and releases the service', async () => {
  const t = await setup(),
    socket = t.connect();
  socket.message({ type: 'start', token: 'valid', agentId: 'agent' });
  t.events.ready();
  expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({
    type: 'ready',
    inputSampleRate: 16000,
  });
  socket.emit('message', Buffer.alloc(3200), true);
  expect(t.provider.sendAudio).toHaveBeenCalledOnce();
  t.events.audio(Buffer.from([1, 2]), 24000);
  expect(socket.send).toHaveBeenCalledWith(Buffer.from([1, 2]), {
    binary: true,
  });
  t.events.delegation('d1', '帮我建造');
  await Promise.resolve();
  await Promise.resolve();
  expect(t.delegated).toHaveBeenCalledWith('帮我建造', expect.any(AbortSignal));
  expect(t.provider.deliverDelegation).toHaveBeenCalledWith(
    'd1',
    'Agent 已答复',
  );
  t.events.delegation('d1', '重复请求');
  expect(t.delegated).toHaveBeenCalledOnce();
  await expect(t.store.remove(t.service.id)).rejects.toThrow('正在使用');
  socket.message({ type: 'stop' });
  await t.store.remove(t.service.id);
  expect(t.provider.close).toHaveBeenCalledOnce();
});
it('delegates recent speech at the requested timeline position instead of the whole conversation', async () => {
  const t = await setup(),
    socket = t.connect();
  socket.message({ type: 'start', token: 'valid', agentId: 'agent' });
  t.events.ready();
  t.events.transcript('human', '旧对话'.repeat(100), {
    startMs: 0,
    endMs: 1000,
  });
  t.events.transcript('human', '请跟着我', { startMs: 20000, endMs: 21000 });
  t.events.transcript('human', '后面的话', { startMs: 22000, endMs: 22500 });
  t.events.delegation('follow', undefined, 21500);
  expect(t.delegated).toHaveBeenCalledWith('请跟着我', expect.any(AbortSignal));
  socket.close();
});
it('groups spoken replies into chat messages and flushes on interruption or stop', async () => {
  const t = await setup(),
    socket = t.connect();
  socket.message({ type: 'start', token: 'valid', agentId: 'agent' });
  t.events.ready();
  t.events.transcript('human', '你好');
  t.events.transcript('agent', 'Hello');
  t.events.transcript('agent', ' world');
  expect(t.publishTranscript).not.toHaveBeenCalled();
  vi.advanceTimersByTime(2000);
  expect(t.publishTranscript).toHaveBeenCalledWith('Hello world');
  t.events.transcript('agent', '新的回答');
  t.events.interrupted();
  expect(t.publishTranscript).toHaveBeenLastCalledWith('新的回答');
  t.events.transcript('agent', '最后一句');
  socket.message({ type: 'stop' });
  expect(t.publishTranscript).toHaveBeenLastCalledWith('最后一句');
  expect(t.publishTranscript).toHaveBeenCalledTimes(3);
});
it('does not publish a queued reply after the participants leave range', async () => {
  const t = await setup(),
    socket = t.connect();
  socket.message({ type: 'start', token: 'valid', agentId: 'agent' });
  t.events.ready();
  t.events.transcript('agent', '不应送达');
  t.events.transcript('human', '也不应送达');
  t.invalidate();
  vi.advanceTimersByTime(2000);
  expect(t.publishTranscript).not.toHaveBeenCalled();
  expect(t.publishHumanTranscript).not.toHaveBeenCalled();
});
it('shows player speech once for multiple Agents and transfers ownership if one disconnects', async () => {
  const t = await setup(),
    first = t.connect();
  first.message({ type: 'start', token: 'valid', agentId: 'agent' });
  const firstEvents = t.events;
  firstEvents.ready();
  const second = t.connect();
  second.message({ type: 'start', token: 'valid', agentId: 'other' });
  const secondEvents = t.events;
  secondEvents.ready();
  firstEvents.transcript('human', '你');
  secondEvents.transcript('human', '你好');
  firstEvents.transcript('human', '好');
  vi.advanceTimersByTime(2000);
  expect(t.publishHumanTranscript).toHaveBeenCalledTimes(1);
  expect(t.publishHumanTranscript).toHaveBeenCalledWith('你好');
  first.close();
  secondEvents.transcript('human', '继续说');
  second.message({ type: 'stop' });
  expect(t.publishHumanTranscript).toHaveBeenCalledTimes(2);
  expect(t.publishHumanTranscript).toHaveBeenLastCalledWith('继续说');
});
it('allows one player to reach multiple Agents while retaining the per-Agent lock', async () => {
  const t = await setup(),
    first = t.connect();
  first.message({ type: 'start', token: 'valid', agentId: 'agent' });
  const second = t.connect();
  second.message({ type: 'start', token: 'valid', agentId: 'agent' });
  expect(JSON.parse(second.send.mock.calls[0][0]).type).toBe('error');
  const third = t.connect();
  third.message({ type: 'start', token: 'valid', agentId: 'other' });
  expect(t.factory).toHaveBeenCalledTimes(2);
  first.close();
  const fourth = t.connect();
  fourth.message({ type: 'start', token: 'valid', agentId: 'other' });
  expect(JSON.parse(fourth.send.mock.calls[0][0]).type).toBe('error');
  third.close();
});
it('stops when player or Agent leaves range and never forwards audio afterwards', async () => {
  const t = await setup(),
    socket = t.connect();
  socket.message({ type: 'start', token: 'valid', agentId: 'agent' });
  t.events.ready();
  t.invalidate();
  vi.advanceTimersByTime(1000);
  expect(t.provider.close).toHaveBeenCalledOnce();
  socket.emit('message', Buffer.alloc(3200), true);
  expect(t.provider.sendAudio).not.toHaveBeenCalled();
});
