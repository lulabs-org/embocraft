import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { bridgeOpenAIAsr } from './openai.adapter';
import { Pcm16Upsampler } from '../../../../core/audio/pcm-resample';

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
  bridgeOpenAIAsr(
    client.ws(),
    {
      provider: 'openai',
      name: 'test',
      model: 'gpt-live-transcribe',
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
describe('OpenAI transcription bridge', () => {
  afterEach(() => vi.useRealTimers());
  it('resamples continuously across frame boundaries', () => {
    const convert = new Pcm16Upsampler();
    const a = Buffer.alloc(4),
      b = Buffer.alloc(4);
    a.writeInt16LE(0, 0);
    a.writeInt16LE(3000, 2);
    b.writeInt16LE(6000, 0);
    b.writeInt16LE(9000, 2);
    const out = Buffer.concat([convert.convert(a), convert.convert(b)]);
    expect(
      Array.from({ length: out.length / 2 }, (_, i) => out.readInt16LE(i * 2)),
    ).toEqual([0, 2000, 4000, 6000, 8000]);
  });
  it('opens OpenAI transcription, sends 24 kHz audio, and waits for the final result', () => {
    const t = setup();
    expect(t.sent()[0]).toMatchObject({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { rate: 24000 },
            transcription: { model: 'gpt-live-transcribe', languages: ['zh'] },
          },
        },
      },
    });
    t.upstream.message({ type: 'session.updated' });
    t.client.emit('message', voiced(), true);
    expect(t.sent()[1].type).toBe('input_audio_buffer.append');
    expect(Buffer.from(t.sent()[1].audio, 'base64').length).toBe(4798);
    t.upstream.message({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'a',
      delta: '你好',
    });
    t.client.message({ type: 'finish' });
    expect(t.sent().at(-1).type).toBe('input_audio_buffer.commit');
    expect(t.events().at(-1)).toEqual({ type: 'partial', text: '你好' });
    t.upstream.message({ type: 'input_audio_buffer.committed', item_id: 'a' });
    t.upstream.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: '你好。',
    });
    expect(t.events().slice(-2)).toEqual([
      { type: 'final', text: '你好。' },
      { type: 'finished' },
    ]);
    expect(t.upstream.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('commits speech after a pause without losing the next segment while awaiting a result', () => {
    const t = setup();
    t.upstream.message({ type: 'session.updated' });
    t.client.emit('message', voiced(), true);
    for (let i = 0; i < 8; i++)
      t.client.emit('message', Buffer.alloc(3200), true);
    expect(
      t.sent().filter((x) => x.type === 'input_audio_buffer.commit'),
    ).toHaveLength(1);
    t.client.emit('message', voiced(), true);
    t.upstream.message({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'b',
      delta: '第二句',
    });
    t.client.message({ type: 'finish' });
    t.upstream.message({ type: 'input_audio_buffer.committed', item_id: 'a' });
    t.upstream.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: '第一句',
    });
    expect(t.events().at(-1)).toEqual({ type: 'partial', text: '第二句' });
    expect(
      t.sent().filter((x) => x.type === 'input_audio_buffer.commit'),
    ).toHaveLength(2);
    // A repeated completion for the prior item must not finish the newer commit.
    t.upstream.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: '第一句',
    });
    expect(t.events().some((event) => event.type === 'finished')).toBe(false);
    t.upstream.message({ type: 'input_audio_buffer.committed', item_id: 'b' });
    t.upstream.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'b',
      transcript: '第二句',
    });
    expect(
      t
        .events()
        .filter((x) => x.type === 'final')
        .map((x) => x.text),
    ).toEqual(['第一句', '第二句']);
    expect(t.events().at(-1).type).toBe('finished');
  });
  it('matches OpenAI completion to the committed item even if events arrive out of order', () => {
    const t = setup();
    t.upstream.message({ type: 'session.updated' });
    t.client.emit('message', voiced(), true);
    t.client.message({ type: 'finish' });
    t.upstream.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'other',
      transcript: '错误片段',
    });
    t.upstream.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: '正确片段',
    });
    expect(t.events().some((event) => event.type === 'finished')).toBe(false);
    t.upstream.message({ type: 'input_audio_buffer.committed', item_id: 'a' });
    expect(t.events().filter((event) => event.type === 'final')).toEqual([
      { type: 'final', text: '正确片段' },
    ]);
    expect(t.events().at(-1).type).toBe('finished');
  });
  it('times out a stalled OpenAI commit while recording and cleans up', () => {
    const t = setup();
    t.upstream.message({ type: 'session.updated' });
    t.client.emit('message', voiced(), true);
    for (let i = 0; i < 8; i++)
      t.client.emit('message', Buffer.alloc(3200), true);
    vi.advanceTimersByTime(15000);
    expect(t.events().at(-1)).toMatchObject({ type: 'error' });
    expect(t.upstream.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('pads short recordings so OpenAI receives the entire final audio segment', () => {
    const t = setup();
    t.upstream.message({ type: 'session.updated' });
    t.client.emit('message', voiced().subarray(0, 1600), true);
    t.client.message({ type: 'finish' });
    const chunks = t
      .sent()
      .filter((item) => item.type === 'input_audio_buffer.append');
    expect(chunks).toHaveLength(2);
    expect(t.sent().at(-1).type).toBe('input_audio_buffer.commit');
    expect(
      chunks.reduce(
        (n, item) => n + Buffer.from(item.audio, 'base64').length,
        0,
      ),
    ).toBeGreaterThan(4800);
    t.upstream.message({ type: 'input_audio_buffer.committed', item_id: 'a' });
    t.upstream.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: '你好',
    });
    expect(t.events().at(-1).type).toBe('finished');
  });
  it('rejects invalid frames and hides upstream errors', () => {
    const t = setup();
    t.upstream.message({ type: 'session.updated' });
    t.client.emit('message', Buffer.alloc(3), true);
    expect(t.events().at(-1).type).toBe('error');
    expect(JSON.stringify(t.events())).not.toContain('secret');
    expect(t.upstream.terminate).toHaveBeenCalledOnce();
  });
});
