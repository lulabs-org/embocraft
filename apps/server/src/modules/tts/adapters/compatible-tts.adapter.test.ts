import { expect, it, vi } from 'vitest';
import { validateVoiceService } from '../domain/voice-service-validation';
import { CompatibleTts } from './compatible-tts.adapter';

const remote = {
  name: 'Cloud',
  type: 'compatible',
  baseUrl: 'https://speech.example/v1',
  model: 'test-tts',
  voice: 'alloy',
  speed: 1,
  apiKey: 'secret-for-test',
};

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

it('sends compatible TTS parameters and handles real WAV response without exposing keys', async () => {
  const request = vi.fn<typeof fetch>(
    async () => new Response(new Uint8Array(wav())),
  );
  const config = validateVoiceService(remote);
  const audio = await new CompatibleTts(config, request).synthesize(
    'hello',
    new AbortController().signal,
  );
  expect(audio.durationMs).toBe(1000);
  expect(request.mock.calls[0][0]).toBe(
    'https://speech.example/v1/audio/speech',
  );
  const init = request.mock.calls[0][1]!;
  expect(init.redirect).toBe('error');
  expect(JSON.parse(init.body as string)).toEqual({
    model: 'test-tts',
    input: 'hello',
    voice: 'alloy',
    speed: 1,
    response_format: 'wav',
  });
});

it.each([
  [
    400,
    { code: 'InvalidParameter', message: 'Unsupported voice' },
    '音色不可用',
  ],
  [
    400,
    { error: { code: 'InvalidModel', message: 'model not supported' } },
    '模型不可用',
  ],
  [401, { message: 'secret-for-test' }, 'API Key 无效'],
  [403, {}, '无权调用'],
  [429, {}, '调用额度'],
  [400, '<html>secret-for-test</html>', '请求参数'],
  [500, 'x'.repeat(65537), '服务暂不可用'],
])(
  'reports safe actionable errors for HTTP %s without retries',
  async (status, body, hint) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        typeof body === 'string'
          ? new Response(body, { status })
          : Response.json(body, { status }),
      );
    const result = new CompatibleTts(
      validateVoiceService(remote),
      request,
    ).synthesize('private preview', new AbortController().signal);
    await expect(result).rejects.toThrow(hint);
    await expect(result).rejects.not.toThrow('secret-for-test');
    await expect(result).rejects.not.toThrow('private preview');
    expect(request).toHaveBeenCalledOnce();
  },
);

it('rejects an oversized audio response and does not start an aborted request', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(Buffer.alloc(10 * 1024 * 1024 + 1)));
  const adapter = new CompatibleTts(validateVoiceService(remote), request);
  await expect(
    adapter.synthesize('hello', new AbortController().signal),
  ).rejects.toThrow('响应过大');
  const controller = new AbortController();
  controller.abort();
  await expect(
    adapter.synthesize('hello', controller.signal),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledOnce();
});
