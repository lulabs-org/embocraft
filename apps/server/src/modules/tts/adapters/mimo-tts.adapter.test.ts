import { expect, it, vi } from 'vitest';
import { validateVoiceService } from '../domain/voice-service-validation';
import { MimoTts } from './mimo-tts.adapter';

const remote = {
  name: 'MiMo',
  type: 'mimo',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.5-tts',
  voice: 'mimo_default',
  speed: 1,
  apiKey: 'secret-for-test',
};

const config = (patch: Partial<typeof remote> = {}) =>
  validateVoiceService({ ...remote, ...patch });

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

const audio = () =>
  Response.json({
    choices: [{ message: { audio: { data: wav().toString('base64') } } }],
  });

it('sends text as an assistant message and decodes the inline base64 WAV', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(audio());
  const result = await new MimoTts(config(), request).synthesize(
    '你好',
    new AbortController().signal,
  );
  expect(result.durationMs).toBe(1000);
  const [url, init] = request.mock.calls[0];
  expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
  expect(init?.headers).toMatchObject({
    'api-key': 'secret-for-test',
    Authorization: 'Bearer secret-for-test',
  });
  expect(JSON.parse(init!.body as string)).toEqual({
    model: 'mimo-v2.5-tts',
    messages: [{ role: 'assistant', content: '你好' }],
    audio: { format: 'wav', voice: 'mimo_default' },
    stream: false,
  });
});

it('expresses a non-default speed as a natural-language user hint', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(audio());
  await new MimoTts(config({ speed: 0.8 }), request).synthesize(
    '你好',
    new AbortController().signal,
  );
  expect(JSON.parse(request.mock.calls[0][1]!.body as string).messages).toEqual(
    [
      { role: 'user', content: '请用约 0.8 倍的慢速朗读。' },
      { role: 'assistant', content: '你好' },
    ],
  );
});

it('reports an invalid key and rate limits without echoing provider text', async () => {
  const unauthorized = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ error: { message: 'invalid api key' } }, { status: 401 }),
    );
  await expect(
    new MimoTts(config(), unauthorized).synthesize(
      '你好',
      new AbortController().signal,
    ),
  ).rejects.toThrow('API Key 无效');
  const limited = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({}, { status: 429 }));
  await expect(
    new MimoTts(config(), limited).synthesize(
      '你好',
      new AbortController().signal,
    ),
  ).rejects.toThrow('额度或频率受限');
});

it('rejects a response without inline audio', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ choices: [{ message: {} }] }));
  await expect(
    new MimoTts(config(), request).synthesize(
      '你好',
      new AbortController().signal,
    ),
  ).rejects.toThrow('未返回音频');
});

it('rejects inline audio that is not a WAV container', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      choices: [
        {
          message: {
            audio: { data: Buffer.from('not-a-wav').toString('base64') },
          },
        },
      ],
    }),
  );
  await expect(
    new MimoTts(config(), request).synthesize(
      '你好',
      new AbortController().signal,
    ),
  ).rejects.toThrow('未返回 WAV');
});

it('caps the provider JSON before decoding any audio', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('x'.repeat(10 * 1024 * 1024 + 1)));
  await expect(
    new MimoTts(config(), request).synthesize(
      '你好',
      new AbortController().signal,
    ),
  ).rejects.toThrow('响应过大');
});

it('validates MiMo profiles with the official endpoint and default voice', () => {
  expect(config()).toMatchObject({
    type: 'mimo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts',
    voice: 'mimo_default',
    speed: 1,
  });
  expect(() => config({ baseUrl: 'http://api.xiaomimimo.com/v1' })).toThrow(
    'HTTPS',
  );
  expect(() => config({ type: 'unknown' as 'mimo' })).toThrow('语音服务类型');
});
