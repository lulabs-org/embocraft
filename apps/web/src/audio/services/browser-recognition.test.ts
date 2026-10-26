import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserRecognitionSession,
  type BrowserRecognition,
} from './browser-recognition';
class FakeRecognition implements BrowserRecognition {
  static last: FakeRecognition;
  constructor() {
    FakeRecognition.last = this;
  }
  lang = '';
  continuous = false;
  interimResults = false;
  onstart: BrowserRecognition['onstart'] = null;
  onresult: BrowserRecognition['onresult'] = null;
  onerror: BrowserRecognition['onerror'] = null;
  onend: BrowserRecognition['onend'] = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
}
const result = (transcript: string, isFinal = false) =>
  Object.assign([{ transcript }], { isFinal });
const setup = () => {
  const events = {
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onStatus: vi.fn(),
    onError: vi.fn(),
    onEnd: vi.fn(),
  };
  const session = new BrowserRecognitionSession({
    isSecureContext: true,
    webkitSpeechRecognition: FakeRecognition,
  } as unknown as Window);
  session.start('zh-CN', events);
  return { session, events, recognition: FakeRecognition.last };
};
afterEach(() => {
  vi.useRealTimers();
});
describe('browser ASR session', () => {
  it('revises interim results, delivers each final once, and waits for final results after stop', () => {
    const { session, events, recognition } = setup();
    expect(recognition.lang).toBe('zh-CN');
    expect(recognition.continuous && recognition.interimResults).toBe(true);
    recognition.onresult?.({ results: [result('你')] });
    recognition.onresult?.({ results: [result('你好')] });
    expect(events.onPartial).toHaveBeenLastCalledWith('你好');
    expect(events.onFinal).not.toHaveBeenCalled();
    recognition.onresult?.({ results: [result('你好', true), result('世')] });
    session.finish();
    expect(recognition.stop).toHaveBeenCalledOnce();
    expect(events.onEnd).not.toHaveBeenCalled();
    recognition.onresult?.({
      results: [result('你好', true), result('世界', true)],
    });
    recognition.onend?.();
    expect(events.onFinal.mock.calls).toEqual([['你好'], ['世界']]);
    expect(events.onEnd).toHaveBeenCalledOnce();
    expect(events.onPartial).toHaveBeenLastCalledWith('');
  });
  it('cancels and ignores queued callbacks from an old session without stopping a new one', () => {
    const { session, events, recognition } = setup();
    const lateResult = recognition.onresult,
      lateEnd = recognition.onend,
      lateError = recognition.onerror;
    session.cancel();
    session.start('en-US', events);
    lateResult?.({ results: [result('late', true)] });
    lateEnd?.();
    lateError?.({ error: 'network' });
    expect(events.onFinal).not.toHaveBeenCalled();
    expect(events.onEnd).not.toHaveBeenCalled();
    expect(events.onError).not.toHaveBeenCalled();
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(FakeRecognition.last.abort).not.toHaveBeenCalled();
    session.cancel();
  });
  it.each(['not-allowed', 'network', 'no-speech', 'language-not-supported'])(
    'terminates on %s without promoting provisional text',
    (error) => {
      const { events, recognition } = setup();
      const lateEnd = recognition.onend;
      recognition.onresult?.({ results: [result('临时')] });
      recognition.onerror?.({ error });
      lateEnd?.();
      expect(events.onError).toHaveBeenCalledOnce();
      expect(events.onEnd).not.toHaveBeenCalled();
      expect(events.onFinal).not.toHaveBeenCalled();
      expect(events.onPartial).toHaveBeenLastCalledWith('');
      expect(recognition.abort).toHaveBeenCalledOnce();
    },
  );
  it('ends capture at five minutes and aborts stalled finalization', () => {
    vi.useFakeTimers();
    const { session, events, recognition } = setup();
    vi.advanceTimersByTime(300000);
    expect(recognition.stop).toHaveBeenCalledOnce();
    session.finish();
    expect(recognition.stop).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10000);
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(events.onError).toHaveBeenCalledWith(
      expect.stringContaining('超时'),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports unsupported or insecure browsers without trying to record', () => {
    for (const browser of [
      { isSecureContext: true },
      { SpeechRecognition: FakeRecognition, isSecureContext: false },
    ]) {
      const session = new BrowserRecognitionSession(
        browser as unknown as Window,
      );
      const onError = vi.fn();
      expect(session.available).toBe(false);
      session.start('zh-CN', {
        onError,
        onPartial: vi.fn(),
        onFinal: vi.fn(),
        onStatus: vi.fn(),
        onEnd: vi.fn(),
      });
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('不支持'));
    }
  });
  it('handles a synchronous start failure and clears all timers', () => {
    vi.useFakeTimers();
    class BrokenRecognition extends FakeRecognition {
      start = vi.fn(() => {
        throw new Error('permission');
      });
    }
    const session = new BrowserRecognitionSession({
      isSecureContext: true,
      SpeechRecognition: BrokenRecognition,
    } as unknown as Window);
    const onError = vi.fn();
    session.start('en-US', {
      onError,
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      onStatus: vi.fn(),
      onEnd: vi.fn(),
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
