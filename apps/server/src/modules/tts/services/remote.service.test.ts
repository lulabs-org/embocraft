import { expect, it, vi } from 'vitest';

import { validateVoiceService } from '../persistence/voice-service-store';

import { RemoteTts } from './remote.service';

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
  const audio = await new RemoteTts(config, request).synthesize(
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

it('fetches Bailian audio only from its output hosts and never forwards the API key to storage', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        output: {
          audio: {
            url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav?signature=test',
          },
        },
      }),
    )
    .mockResolvedValueOnce(new Response(new Uint8Array(wav())));
  const config = validateVoiceService({
    ...remote,
    type: 'bailian',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'qwen3-tts-flash',
    voice: 'Cherry',
  });
  await new RemoteTts(config, request).synthesize(
    '你好',
    new AbortController().signal,
  );
  expect(JSON.parse(request.mock.calls[0][1]!.body as string).input).toEqual({
    text: '你好',
    voice: 'Cherry',
    language_type: 'Auto',
  });
  expect(String(request.mock.calls[1][0])).toMatch(/^https:/);
  expect(request.mock.calls[1][1]?.headers).toBeUndefined();
  request
    .mockReset()
    .mockResolvedValueOnce(
      Response.json({ output: { audio: { url: 'http://127.0.0.1/private' } } }),
    );
  await expect(
    new RemoteTts(config, request).synthesize(
      'hi',
      new AbortController().signal,
    ),
  ).rejects.toThrow('音频地址');
  expect(request).toHaveBeenCalledOnce();
});

it.each([
  'qwen-audio-3.0-tts-flash',
  'qwen-audio-3.0-tts-plus',
  'qwen-audio-3.1-tts-flash',
])('routes %s to SpeechSynthesizer with WAV parameters', async (model) => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        output: {
          audio: {
            url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav',
          },
        },
      }),
    )
    .mockResolvedValueOnce(new Response(new Uint8Array(wav())));
  const config = validateVoiceService({
    ...remote,
    type: 'bailian',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model,
    voice: 'longanhuan_v3.1',
  });
  const result = await new RemoteTts(config, request).synthesize(
    '你好',
    new AbortController().signal,
  );
  expect(request.mock.calls[0][0]).toBe(
    'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
  );
  expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({
    model,
    input: {
      text: '你好',
      voice: 'longanhuan_v3.1',
      format: 'wav',
      sample_rate: 16000,
    },
  });
  expect(request.mock.calls[1][1]?.headers).toBeUndefined();
  expect(result.durationMs).toBe(1000);
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
    const result = new RemoteTts(
      validateVoiceService(remote),
      request,
    ).synthesize('private preview', new AbortController().signal);
    await expect(result).rejects.toThrow(hint);
    await expect(result).rejects.not.toThrow('secret-for-test');
    await expect(result).rejects.not.toThrow('private preview');
    expect(request).toHaveBeenCalledOnce();
  },
);

it('rejects missing Bailian output before requesting any audio URL', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ output: {} }));
  const config = validateVoiceService({
    ...remote,
    type: 'bailian',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'qwen-audio-3.1-tts-flash',
    voice: 'longanhuan_v3.1',
  });
  await expect(
    new RemoteTts(config, request).synthesize(
      'hello',
      new AbortController().signal,
    ),
  ).rejects.toThrow('未返回有效的音频地址');
  expect(request).toHaveBeenCalledOnce();
});
