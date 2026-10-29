import type { OpenAiAsrDraft } from '@voxel/shared';
import { expect, it, vi } from 'vitest';
import { OpenAiSpeech } from './openai-speech';

const settings = (
  patch: Partial<OpenAiAsrDraft> = {},
): OpenAiAsrDraft & { provider: 'openai' } => ({
  provider: 'openai',
  baseUrl: 'https://gateway.test/v1',
  model: 'whisper-1',
  apiKey: 'key-1',
  ...patch,
});
const signal = () => new AbortController().signal;

it('forwards a snapshot to the OpenAI transcription endpoint and trims the reply', async () => {
  const request = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ text: '  你好  世界 ' }), { status: 200 }),
  );
  const speech = new OpenAiSpeech(request as unknown as typeof fetch);
  await expect(
    speech.transcribe(
      Buffer.from('audio'),
      'audio/wav; codecs=1',
      'zh',
      signal(),
      settings(),
    ),
  ).resolves.toBe('你好 世界');
  const [url, init] = request.mock.calls[0];
  expect(url).toBe('https://gateway.test/v1/audio/transcriptions');
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ Authorization: 'Bearer key-1' });
  const form = init.body as FormData;
  expect(form.get('model')).toBe('whisper-1');
  expect(form.get('language')).toBe('zh');
  expect((form.get('file') as File).name).toBe('audio.wav');
});

it('omits the authorization header for keyless self-hosted gateways', async () => {
  const request = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ text: 'ok' }), { status: 200 }),
  );
  const speech = new OpenAiSpeech(request as unknown as typeof fetch);
  await speech.transcribe(
    Buffer.from('audio'),
    'audio/webm',
    'en',
    signal(),
    settings({ apiKey: '' }),
  );
  const [, init] = request.mock.calls[0];
  expect(init.headers).toEqual({});
  expect((init.body as FormData).get('file')).toMatchObject({
    type: 'audio/webm',
  });
});

it('maps remote rejections onto the shared transcription errors', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response('nope', { status: 401 }))
    .mockResolvedValueOnce(new Response('boom', { status: 500 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ text: '' }), { status: 200 }),
    )
    .mockRejectedValueOnce(new Error('offline'));
  const speech = new OpenAiSpeech(request as unknown as typeof fetch);
  const transcribe = () =>
    speech.transcribe(
      Buffer.from('audio'),
      'audio/wav',
      'zh',
      signal(),
      settings(),
    );
  await expect(transcribe()).rejects.toThrow('API Key');
  await expect(transcribe()).rejects.toMatchObject({ status: 502 });
  await expect(transcribe()).rejects.toMatchObject({
    status: 400,
    code: 'no-speech',
  });
  await expect(transcribe()).rejects.toThrow('失败或超时');
});

it('validates format, size and language before contacting the gateway', async () => {
  const request = vi.fn();
  const speech = new OpenAiSpeech(request as unknown as typeof fetch);
  await expect(
    speech.transcribe(
      Buffer.from('audio'),
      'audio/flac',
      'zh',
      signal(),
      settings(),
    ),
  ).rejects.toMatchObject({ status: 415 });
  await expect(
    speech.transcribe(Buffer.alloc(0), 'audio/wav', 'zh', signal(), settings()),
  ).rejects.toMatchObject({ status: 413 });
  await expect(
    speech.transcribe(
      Buffer.from('audio'),
      'audio/wav',
      'ja',
      signal(),
      settings(),
    ),
  ).rejects.toThrow('中文或英文');
  await expect(
    speech.transcribe(Buffer.from('audio'), 'audio/wav', 'zh', signal()),
  ).rejects.toThrow('已保存');
  expect(request).not.toHaveBeenCalled();
});

it('advertises configuration readiness without probing the network', async () => {
  const speech = new OpenAiSpeech(vi.fn() as unknown as typeof fetch);
  await expect(speech.status(settings())).resolves.toMatchObject({
    available: true,
  });
  await expect(speech.status()).resolves.toMatchObject({ available: false });
});
