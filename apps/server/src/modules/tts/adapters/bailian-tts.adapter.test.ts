import { expect, it, vi } from 'vitest';
import { validateVoiceService } from '../domain/voice-service-validation';
import { BailianTts } from './bailian-tts.adapter';

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
  await new BailianTts(config, request).synthesize(
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
    new BailianTts(config, request).synthesize(
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
  const result = await new BailianTts(config, request).synthesize(
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
    new BailianTts(config, request).synthesize(
      'hello',
      new AbortController().signal,
    ),
  ).rejects.toThrow('未返回有效的音频地址');
  expect(request).toHaveBeenCalledOnce();
});

it.each([
  'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com.evil.example/audio',
  'https://user:pass@dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio',
  'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:444/audio',
  'file://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio',
])('rejects untrusted audio URL %s', async (url) => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ output: { audio: { url } } }));
  const config = validateVoiceService({
    ...remote,
    type: 'bailian',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  });
  await expect(
    new BailianTts(config, request).synthesize(
      'hello',
      new AbortController().signal,
    ),
  ).rejects.toThrow('音频地址');
  expect(request).toHaveBeenCalledOnce();
});

it('limits the provider JSON response before requesting the audio', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('x'.repeat(64 * 1024 + 1)));
  const config = validateVoiceService({
    ...remote,
    type: 'bailian',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  });
  await expect(
    new BailianTts(config, request).synthesize(
      'hello',
      new AbortController().signal,
    ),
  ).rejects.toThrow('响应过大');
  expect(request).toHaveBeenCalledOnce();
});
