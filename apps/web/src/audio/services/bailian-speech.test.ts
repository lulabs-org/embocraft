import { afterEach, expect, it, vi } from 'vitest';
import { BailianSpeechSession } from './bailian-speech';
import type { LiveSpeechEvents } from './live-speech';
function setup() {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', { OPEN: 1 });
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
    onmessage: undefined as undefined | ((event: { data: string }) => void),
    onclose: undefined as undefined | (() => void),
    onerror: undefined as undefined | (() => void),
  };
  const events: LiveSpeechEvents = {
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onEnd: vi.fn(),
    onError: vi.fn(),
    onStatus: vi.fn(),
  };
  const connect = vi.fn(() => socket as unknown as WebSocket);
  const session = new BailianSpeechSession(
    'service A',
    'zh-CN',
    events,
    connect,
  );
  const message = (value: object) =>
    socket.onmessage!({ data: JSON.stringify(value) });
  return { socket, events, session, message, connect };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('waits for readiness, streams binary audio and keeps accepting the final tail after finish', async () => {
  const t = setup();
  expect(t.connect).toHaveBeenCalledWith(
    expect.stringContaining('serviceId=service%20A&language=zh'),
  );
  t.session.feed(new Uint8Array(10));
  expect(t.socket.send).not.toHaveBeenCalled();
  t.message({ type: 'ready' });
  await t.session.ready;
  t.session.feed(new Uint8Array(10));
  expect(t.socket.send).toHaveBeenCalledWith(new Uint8Array(10));
  t.message({ type: 'partial', text: '你好' });
  expect(t.events.onFinal).not.toHaveBeenCalled();
  t.session.finish();
  expect(t.socket.close).not.toHaveBeenCalled();
  t.message({ type: 'final', text: '你好。' });
  t.message({ type: 'finished' });
  expect(t.events.onFinal).toHaveBeenCalledWith('你好。');
  expect(t.events.onEnd).toHaveBeenCalledOnce();
  expect(t.socket.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels pending startup and ignores late results', async () => {
  const t = setup();
  const ready = expect(t.session.ready).rejects.toThrow('取消');
  t.session.cancel();
  await ready;
  t.message({ type: 'final', text: 'late' });
  t.socket.onclose!();
  expect(t.events.onFinal).not.toHaveBeenCalled();
  expect(t.events.onError).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('fails visibly on disconnect and bounds finalization', async () => {
  const t = setup();
  t.message({ type: 'ready' });
  await t.session.ready;
  t.socket.onclose!();
  expect(t.events.onError).toHaveBeenCalledWith(
    expect.stringContaining('中断'),
  );
  const u = setup();
  u.message({ type: 'ready' });
  await u.session.ready;
  u.session.finish();
  vi.advanceTimersByTime(20000);
  expect(u.events.onError).toHaveBeenCalledWith(
    expect.stringContaining('超时'),
  );
  expect(u.events.onEnd).not.toHaveBeenCalled();
});
