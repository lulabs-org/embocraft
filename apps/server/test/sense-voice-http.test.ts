import { expect, it, vi, afterEach } from 'vitest';
import type { SenseVoiceAsrDraft } from '@voxel/shared';
import { AppError } from '../src/core/errors/app-error';
import { validateSenseVoiceSettings } from '../src/modules/asr/domain';
import { SenseVoiceAdapter } from '../src/modules/asr/engines/sense-voice/sense-voice.adapter';
import { SpeechRouter } from '../src/modules/asr/engines/speech-router';

/** 16 kHz 单声道 PCM16 WAV，与浏览器上传的录音快照保持一致。 */
function pcmWav(seconds = 1, sampleRate = 16000) {
  const count = Math.round(seconds * sampleRate),
    bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + count * 2, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++)
    bytes.writeInt16LE(Math.round(Math.sin(i / 8) * 9000), 44 + i * 2);
  return bytes;
}

const settings: SenseVoiceAsrDraft = {
  baseUrl: 'http://asr.local/v1',
  model: 'iic/SenseVoiceSmall',
  language: 'zh',
  apiKey: 'secret',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('validates model IDs and reuses keys only for the same endpoint', () => {
  const value = validateSenseVoiceSettings({
    baseUrl: 'http://127.0.0.1:8000/v1/',
    model: 'iic/SenseVoiceSmall',
    language: 'zh',
    apiKey: 'secret',
  });
  expect(value).toEqual({
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'iic/SenseVoiceSmall',
    language: 'zh',
    apiKey: 'secret',
  });
  expect(() =>
    validateSenseVoiceSettings({
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: '../etc',
      language: 'zh',
    }),
  ).toThrow('SenseVoice 模型 ID');
  expect(() =>
    validateSenseVoiceSettings({
      baseUrl: 'ftp://asr.local',
      model: 'iic/SenseVoiceSmall',
      language: 'zh',
    }),
  ).toThrow('SenseVoice 接口须为 HTTP 或 HTTPS 地址');
  // 同一地址允许留空沿用旧密钥，换地址则必须重新填写。
  expect(
    validateSenseVoiceSettings(
      {
        baseUrl: 'http://127.0.0.1:8000/v1',
        model: 'iic/SenseVoiceSmall',
        language: 'zh',
        apiKey: '',
      },
      { ...value, baseUrl: 'http://127.0.0.1:8000/v1' },
    ).apiKey,
  ).toBe('secret');
  expect(() =>
    validateSenseVoiceSettings(
      {
        baseUrl: 'http://127.0.0.1:9000/v1',
        model: 'iic/SenseVoiceSmall',
        language: 'zh',
        apiKey: '',
      },
      { ...value, baseUrl: 'http://127.0.0.1:8000/v1' },
    ),
  ).toThrow('重新填写密钥');
});

it('reports readiness through health and falls back to the model list', async () => {
  const requests: string[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    requests.push(String(url));
    return String(url).endsWith('/health')
      ? new Response('', { status: 503 })
      : new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const adapter = new SenseVoiceAdapter(undefined, fetcher);
  const status = await adapter.status(settings);
  expect(status.available).toBe(true);
  expect(status.reason).toContain('外部容器');
  expect(requests).toEqual([
    'http://asr.local/health',
    'http://asr.local/v1/models',
  ]);

  const offline = new SenseVoiceAdapter(
    undefined,
    (async () => new Response('', { status: 502 })) as typeof fetch,
  );
  expect((await offline.status(settings)).available).toBe(false);
});

it('lists remote models without triggering downloads', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'iic/SenseVoiceSmall' }, { id: 'sensevoice' }],
        }),
        { status: 200 },
      ),
  ) as unknown as typeof fetch;
  const adapter = new SenseVoiceAdapter('http://asr.local/v1', fetcher);
  expect(await adapter.listModels()).toEqual([
    { name: 'iic/SenseVoiceSmall' },
    { name: 'sensevoice' },
  ]);
});

it('posts normalized WAV with model, language and bearer credentials', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/health'))
        return new Response('', { status: 200 });
      return new Response(JSON.stringify({ text: '你好世界' }), {
        status: 200,
      });
    },
  ) as unknown as typeof fetch;
  const adapter = new SenseVoiceAdapter(undefined, fetcher);
  const text = await adapter.transcribe(
    pcmWav(),
    'audio/wav',
    'zh',
    new AbortController().signal,
    settings,
  );
  expect(text).toBe('你好世界');
  const post = calls.find((call) => call.init?.method === 'POST')!;
  expect(post.url).toBe('http://asr.local/v1/audio/transcriptions');
  expect((post.init?.headers as Record<string, string>).Authorization).toBe(
    'Bearer secret',
  );
  const form = post.init?.body as FormData;
  expect(form.get('model')).toBe('iic/SenseVoiceSmall');
  expect(form.get('language')).toBe('zh');
  expect(form.get('response_format')).toBe('json');
  const file = form.get('file') as File;
  expect(file.type).toBe('audio/wav');
  expect(file.size).toBe(pcmWav().length);
});

it('omits the language field for auto detection', async () => {
  let form: FormData | undefined;
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/health'))
        return new Response('', { status: 200 });
      form = init?.body as FormData;
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    },
  ) as unknown as typeof fetch;
  const adapter = new SenseVoiceAdapter(undefined, fetcher);
  await adapter.transcribe(
    pcmWav(),
    'audio/wav',
    'auto',
    new AbortController().signal,
    { ...settings, language: 'auto' },
  );
  expect(form?.has('language')).toBe(false);
});

it('maps empty, invalid and upstream failures to explicit errors', async () => {
  const adapter = (body: unknown, status = 200) =>
    new SenseVoiceAdapter(undefined, (async (url: string | URL | Request) =>
      String(url).endsWith('/health')
        ? new Response('', { status: 200 })
        : new Response(JSON.stringify(body), { status })) as typeof fetch);
  await expect(
    adapter({ text: '  ' }).transcribe(
      pcmWav(),
      'audio/wav',
      'zh',
      new AbortController().signal,
      settings,
    ),
  ).rejects.toMatchObject({ status: 400, code: 'no-speech' });
  await expect(
    adapter({ text: 'x'.repeat(241) }).transcribe(
      pcmWav(),
      'audio/wav',
      'zh',
      new AbortController().signal,
      settings,
    ),
  ).rejects.toBeInstanceOf(AppError);
  await expect(
    adapter({ error: 'boom' }, 500).transcribe(
      pcmWav(),
      'audio/wav',
      'zh',
      new AbortController().signal,
      settings,
    ),
  ).rejects.toMatchObject({ status: 502 });
});

it('serializes concurrent decodes and rejects the overflow request', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/health')) {
      await gate;
      return new Response('', { status: 200 });
    }
    return new Response(JSON.stringify({ text: '你好' }), { status: 200 });
  }) as unknown as typeof fetch;
  const adapter = new SenseVoiceAdapter(undefined, fetcher);
  const first = adapter.transcribe(
    pcmWav(),
    'audio/wav',
    'zh',
    new AbortController().signal,
    settings,
  );
  await expect(
    adapter.transcribe(
      pcmWav(),
      'audio/wav',
      'zh',
      new AbortController().signal,
      settings,
    ),
  ).rejects.toMatchObject({ status: 429 });
  release();
  await expect(first).resolves.toBe('你好');
});

it('routes saved SenseVoice profiles and configured deployments to the adapter', async () => {
  const whisper = {
    provider: 'whisper' as const,
    status: async () => ({ available: true }),
    normalize: async () => ({ bytes: Buffer.alloc(0), durationMs: 0 }),
    transcribe: async () => '',
  };
  const senseVoice = new SenseVoiceAdapter(
    undefined,
    (async () => new Response('', { status: 200 })) as typeof fetch,
  );
  const router = new SpeechRouter({ whisper, senseVoice });
  expect(await router.engineFor({ provider: 'sense-voice' })).toBe(senseVoice);
  expect(await router.engineFor({ provider: 'whisper' })).toBe(whisper);

  vi.stubEnv('ASR_PROVIDER', 'auto');
  vi.stubEnv('SENSE_VOICE_API_URL', 'http://asr.local/v1');
  expect(await router.engineFor()).toBe(senseVoice);
  vi.stubEnv('SENSE_VOICE_API_URL', '');
  expect(await router.engineFor()).toBe(whisper);
});
