import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { bridgeBailianAsr } from './bailian.service';
import { DEFAULT_BAILIAN_ASR } from '@voxel/shared';

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
  const connect = vi.fn(() => upstream.ws());
  bridgeBailianAsr(
    client.ws(),
    { ...DEFAULT_BAILIAN_ASR, apiKey: 'private-key' },
    'zh',
    connect,
  );
  upstream.emit('open');
  const run = JSON.parse(upstream.send.mock.calls[0][0]);
  const event = (event: string, sentence?: object) =>
    upstream.message({
      header: { task_id: run.header.task_id, event },
      payload: { output: { sentence } },
    });
  const messages = () =>
    client.send.mock.calls.map(([value]) => JSON.parse(value));
  return { client, upstream, run, event, messages, connect };
}
afterEach(() => vi.useRealTimers());
it('streams PCM only after task-started, replaces interim text and confirms final tail before closing', () => {
  const t = setup();
  expect(t.connect).toHaveBeenCalledWith(
    'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    'private-key',
  );
  expect(t.run.payload).toMatchObject({
    model: 'fun-asr-realtime',
    parameters: { format: 'pcm', sample_rate: 16000, language_hints: ['zh'] },
  });
  t.event('task-started');
  const audio = Buffer.alloc(1600);
  t.client.emit('message', audio, true);
  expect(t.upstream.send).toHaveBeenLastCalledWith(audio);
  t.event('result-generated', {
    sentence_id: 0,
    text: '你',
    sentence_end: false,
  });
  t.event('result-generated', {
    sentence_id: 0,
    text: '你好',
    sentence_end: false,
  });
  t.event('result-generated', {
    sentence_id: 0,
    text: '你好。',
    sentence_end: true,
  });
  t.event('result-generated', {
    sentence_id: 0,
    text: '你好。',
    sentence_end: true,
  });
  t.client.message({ type: 'finish' });
  expect(
    JSON.parse(t.upstream.send.mock.calls.at(-1)![0]).header,
  ).toMatchObject({ action: 'finish-task', task_id: t.run.header.task_id });
  expect(t.client.close).not.toHaveBeenCalled();
  t.event('result-generated', {
    begin_time: 1000,
    text: '再见。',
    sentence_end: true,
  });
  t.event('task-finished');
  expect(
    t
      .messages()
      .filter((m) => m.type === 'final')
      .map((m) => m.text),
  ).toEqual(['你好。', '再见。']);
  expect(t.messages().at(-1)).toEqual({ type: 'finished' });
  expect(t.upstream.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('rejects early PCM without sending it upstream', () => {
  const t = setup();
  t.client.emit('message', Buffer.alloc(1600), true);
  expect(t.upstream.send).toHaveBeenCalledTimes(1);
  expect(t.messages().at(-1).type).toBe('error');
  expect(t.upstream.terminate).toHaveBeenCalledOnce();
});
it('cancels upstream and drops late results when browser disconnects', () => {
  const t = setup();
  t.event('task-started');
  t.client.emit('close');
  t.event('result-generated', {
    sentence_id: 0,
    text: 'late',
    sentence_end: true,
  });
  expect(t.messages()).toEqual([{ type: 'ready' }]);
  expect(vi.getTimerCount()).toBe(0);
});
it('bounds connection and finalization waits and sanitizes provider failures', () => {
  const t = setup();
  vi.advanceTimersByTime(15000);
  expect(t.messages().at(-1).message).toContain('超时');
  const u = setup();
  u.event('task-started');
  u.client.message({ type: 'finish' });
  vi.advanceTimersByTime(15000);
  expect(u.messages().at(-1).message).toContain('最后一句超时');
  const v = setup();
  v.upstream.message({
    header: {
      task_id: v.run.header.task_id,
      event: 'task-failed',
      error_message: 'private-key',
    },
  });
  expect(JSON.stringify(v.messages())).not.toContain('private-key');
});
it.each(['oversized', 'odd', 'backpressure', 'malformed', 'disconnect'])(
  'stops on %s without committing interim text',
  (failure) => {
    const t = setup();
    t.event('task-started');
    if (failure === 'oversized')
      t.client.emit('message', Buffer.alloc(3202), true);
    if (failure === 'odd') t.client.emit('message', Buffer.alloc(3), true);
    if (failure === 'backpressure') {
      t.upstream.bufferedAmount = 128001;
      t.client.emit('message', Buffer.alloc(1600), true);
    }
    if (failure === 'malformed')
      t.upstream.emit('message', Buffer.from('not json'), false);
    if (failure === 'disconnect') t.upstream.emit('close');
    expect(t.messages().at(-1).type).toBe('error');
    expect(t.messages().some((m) => m.type === 'final')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([
  [401, '更换密钥'],
  [403, '访问权限'],
  [429, '过于频繁'],
  [503, '暂时不可用'],
  [404, '握手失败'],
])(
  'reports HTTP %s handshake failures without leaking response details',
  (statusCode, hint) => {
    const t = setup();
    const response = { statusCode, destroy: vi.fn(), body: 'private-key' };
    t.upstream.emit('unexpected-response', {}, response);
    // ws may emit error/close after termination; only the original cause should reach the UI.
    t.upstream.emit('error', new Error('private-key'));
    t.upstream.emit('close');
    expect(t.messages()).toHaveLength(1);
    expect(t.messages()[0]).toMatchObject({
      type: 'error',
      message: expect.stringContaining(hint),
    });
    expect(JSON.stringify(t.messages())).not.toContain('private-key');
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(t.upstream.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([
  ['ENOTFOUND', 'DNS'],
  ['EAI_AGAIN', 'DNS'],
  ['ETIMEDOUT', '超时'],
  ['ECONNRESET', '重置'],
  ['ECONNREFUSED', '拒绝'],
  ['UNKNOWN', 'TLS'],
])(
  'distinguishes network error %s from authentication failures',
  (code, hint) => {
    const t = setup();
    t.upstream.emit('error', Object.assign(new Error('private-key'), { code }));
    expect(t.messages()[0].message).toContain(hint);
    expect(JSON.stringify(t.messages())).not.toContain('private-key');
    expect(t.client.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);
