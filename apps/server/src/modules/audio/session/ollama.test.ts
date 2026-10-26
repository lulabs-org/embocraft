import { it, expect, vi, afterEach } from 'vitest';

import { OllamaVoiceProvider } from './ollama';

import type { VoiceEvent } from './types';

afterEach(() => vi.useRealTimers());

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('sends text to the local API, emits one reply and limits output', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ message: { content: '你好！' } })),
    );
  vi.stubGlobal('fetch', fetcher);
  const events: VoiceEvent[] = [];
  const s = new OllamaVoiceProvider('local-model').create((e) =>
    events.push(e),
  );
  s.push({ kind: 'text', text: '你好' });
  await vi.waitFor(() => expect(events.at(-1)?.state).toBe('idle'));
  expect(events.at(-1)?.speakText).toBe('你好！');
  expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/chat');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
    model: 'local-model',
    stream: false,
  });
  s.close();
});

it.each(['interrupt', 'close', 'replace'] as const)(
  'suppresses stale model results after %s',
  async (action) => {
    let resolve!: (r: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ message: { content: 'new reply' } })),
      );
    vi.stubGlobal('fetch', fetcher);
    const events: VoiceEvent[] = [];
    const s = new OllamaVoiceProvider('local-model').create((e) =>
      events.push(e),
    );
    s.push({ kind: 'text', text: 'old' });
    if (action === 'replace') s.push({ kind: 'text', text: 'new' });
    else s[action]();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    resolve(
      new Response(JSON.stringify({ message: { content: 'stale reply' } })),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(events.some((e) => e.subtitle === 'stale reply')).toBe(false);
    if (action === 'replace') expect(events.at(-1)?.subtitle).toBe('new reply');
    s.close();
  },
);

it.each([
  new Response('missing', { status: 404 }),
  new Response('{}'),
  new Response('not json'),
])(
  'reports upstream failure without falling back to fake AI',
  async (response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const events: VoiceEvent[] = [];
    const s = new OllamaVoiceProvider('local-model').create((e) =>
      events.push(e),
    );
    s.push({ kind: 'text', text: 'hi' });
    await vi.waitFor(() => expect(events.at(-1)?.state).toBe('error'));
    expect(events.at(-1)?.speakText).toBeUndefined();
    s.close();
  },
);

it('times out a stalled local model', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    ),
  );
  const events: VoiceEvent[] = [];
  const s = new OllamaVoiceProvider('local-model', undefined, 100).create((e) =>
    events.push(e),
  );
  s.push({ kind: 'text', text: 'hi' });
  await vi.advanceTimersByTimeAsync(100);
  expect(events.at(-1)).toMatchObject({ state: 'error' });
  expect(events.at(-1)?.subtitle).toContain('超时');
  s.close();
});

it('rejects raw audio and invalid text without starting inference', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const events: VoiceEvent[] = [];
  const s = new OllamaVoiceProvider('local-model').create((e) =>
    events.push(e),
  );
  s.push({ kind: 'audio', pcm: new Uint8Array(2), sampleRate: 16000 });
  s.push({ kind: 'text', text: ' ' });
  expect(events.every((e) => e.state === 'error')).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  s.close();
});
