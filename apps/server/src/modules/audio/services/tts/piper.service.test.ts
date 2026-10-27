import { afterEach, expect, it, vi } from 'vitest';

import { PiperTts } from './piper.service';

import { DEFAULT_PIPER_MODEL, PIPER_MODELS } from '@voxel/shared';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const wav = () => {
  const b = Buffer.alloc(32044);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(32000, 40);
  for (let i = 44; i < b.length; i += 2) b.writeInt16LE(1000, i);
  return b;
};

it('requests the model voice, speed and 16k PCM WAV and validates the returned duration', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(wav()));
  const result = await new PiperTts(
    { speed: 0.8 },
    'http://speech/v1',
    request,
  ).synthesize('你好', new AbortController().signal);
  expect(result.durationMs).toBe(1000);
  expect(JSON.parse(request.mock.calls[0][1]?.body as string)).toEqual({
    model: DEFAULT_PIPER_MODEL,
    voice: 'huayan',
    input: '你好',
    speed: 0.8,
    response_format: 'wav',
    sample_rate: 16000,
  });
  expect(request.mock.calls[0][0]).toBe('http://speech/v1/audio/speech');
});

it.each(PIPER_MODELS)(
  'synthesizes the selected $name without falling back to another voice',
  async (model) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(wav()));
    await new PiperTts(
      { model: model.id },
      'http://speech/v1',
      request,
    ).synthesize('你好', new AbortController().signal);
    expect(JSON.parse(request.mock.calls[0][1]?.body as string)).toMatchObject({
      model: model.id,
      voice: model.voice,
    });
  },
);

it('reports missing models and unreachable services, rejects invalid/oversized audio and honors cancellation', async () => {
  const request = vi.fn<typeof fetch>();
  const tts = new PiperTts({}, 'http://speech/v1', request);
  request.mockResolvedValueOnce(new Response('', { status: 404 }));
  await expect(
    tts.synthesize('你好', new AbortController().signal),
  ).rejects.toThrow('未安装');
  request.mockRejectedValueOnce(Error('offline'));
  await expect(
    tts.synthesize('你好', new AbortController().signal),
  ).rejects.toThrow('无法连接');
  request.mockResolvedValueOnce(new Response('invalid'));
  await expect(
    tts.synthesize('你好', new AbortController().signal),
  ).rejects.toThrow();
  request.mockResolvedValueOnce(
    new Response(Buffer.alloc(3 * 1024 * 1024 + 1)),
  );
  await expect(
    tts.synthesize('你好', new AbortController().signal),
  ).rejects.toThrow('过大');
  const abort = new AbortController();
  abort.abort();
  const count = request.mock.calls.length;
  await expect(tts.synthesize('你好', abort.signal)).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(count);
});
