import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { bridgeGeminiAsr } from './gemini.adapter';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn(() => this.emit('close'));
  terminate = vi.fn(() => this.emit('close'));
  ws() {
    return this as unknown as WebSocket;
  }
  message(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
}
function setup() {
  vi.useFakeTimers();
  const client = new Socket(),
    upstream = new Socket();
  bridgeGeminiAsr(
    client.ws(),
    {
      provider: 'gemini',
      name: 'test',
      model: 'gemini-3.5-transcribe-live',
      apiKey: 'secret',
    },
    'zh',
    () => upstream.ws(),
  );
  upstream.emit('open');
  const sent = () => upstream.send.mock.calls.map(([v]) => JSON.parse(v));
  const events = () => client.send.mock.calls.map(([v]) => JSON.parse(v));
  return { client, upstream, sent, events };
}
function voiced() {
  const frame = Buffer.alloc(3200);
  for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(1200, i);
  return frame;
}
describe('Gemini transcription bridge', () => {
  afterEach(() => vi.useRealTimers());
  it('opens Gemini transcription and forwards interim and final text', () => {
    const t = setup();
    expect(t.sent()[0]).toMatchObject({
      setup: {
        model: 'models/gemini-3.5-transcribe-live',
        inputAudioTranscription: { languageCodes: ['cmn-Hans-CN'] },
      },
    });
    t.upstream.message({ setupComplete: {} });
    t.client.emit('message', voiced(), true);
    expect(t.sent()[1].realtimeInput.audio.mimeType).toBe(
      'audio/pcm;rate=16000',
    );
    t.upstream.message({
      serverContent: { interimInputTranscription: { text: '你好' } },
    });
    t.client.message({ type: 'finish' });
    expect(t.sent().at(-1)).toEqual({
      realtimeInput: { audioStreamEnd: true },
    });
    t.upstream.message({
      serverContent: { inputTranscription: { text: '你好。' } },
    });
    vi.advanceTimersByTime(8000);
    expect(t.events().slice(-3)).toEqual([
      { type: 'partial', text: '' },
      { type: 'final', text: '你好。' },
      { type: 'finished' },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports invalid API keys without exposing the provider close reason', () => {
    const t = setup();
    t.upstream.emit(
      'close',
      1007,
      Buffer.from('API key not valid. Please pass a valid API key. secret'),
    );
    expect(t.events().at(-1)).toEqual({
      type: 'error',
      message: 'Gemini API Key 无效，请检查并重新保存密钥。',
    });
    expect(JSON.stringify(t.events())).not.toContain('secret');
    expect(t.upstream.terminate).toHaveBeenCalledOnce();
  });
  it('reports other rejected configurations without exposing their contents', () => {
    const t = setup();
    t.upstream.emit('close', 1008, Buffer.from('unsupported settings secret'));
    expect(t.events().at(-1).message).toContain('模型权限');
    expect(JSON.stringify(t.events())).not.toContain('secret');
  });
  it('fails rather than discarding an unconfirmed Gemini interim result', () => {
    const t = setup();
    t.upstream.message({ setupComplete: {} });
    t.upstream.message({
      serverContent: { interimInputTranscription: { text: '未确认' } },
    });
    t.client.message({ type: 'finish' });
    vi.advanceTimersByTime(8000);
    expect(t.events().at(-1)).toMatchObject({ type: 'error' });
    expect(t.events().some((event) => event.type === 'finished')).toBe(false);
  });
  it('rejects invalid frames and hides upstream errors', () => {
    const t = setup();
    t.upstream.message({ setupComplete: {} });
    t.client.emit('message', Buffer.alloc(3), true);
    expect(t.events().at(-1).type).toBe('error');
    expect(JSON.stringify(t.events())).not.toContain('secret');
    expect(t.upstream.terminate).toHaveBeenCalledOnce();
  });
});
