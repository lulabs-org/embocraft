import { describe, expect, it, vi } from 'vitest';
import { LocalSpeech } from './local-speech.service';
import { validatePcmWav } from '../../domain/pcm-wav';

function wav(seconds = 1, amplitude = 1000) {
  const data = Buffer.alloc(44 + Math.round(seconds * 32000));
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24);
  data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(data.length - 44, 40);
  for (let i = 44; i < data.length; i += 2) data.writeInt16LE(amplitude, i);
  return data;
}

describe('Whisper transcription service', () => {
  it('rejects silence, malformed, too short and too long audio', () => {
    expect(() => validatePcmWav(wav(1, 0))).toThrow('清晰声音');
    expect(() => validatePcmWav(Buffer.from('invalid'))).toThrow();
    expect(() => validatePcmWav(wav(0.1))).toThrow('太短');
    expect(() => validatePcmWav(wav(21))).toThrow('20 秒');
  });

  it('rejects unsupported input before invoking speech service', async () => {
    const fetcher = vi.fn();
    const speech = new LocalSpeech(
      'http://whisper:8000/v1',
      fetcher as unknown as typeof fetch,
    );
    await expect(
      speech.transcribe(
        Buffer.from('url'),
        'text/plain',
        'zh',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      speech.transcribe(
        Buffer.alloc(5 * 1024 * 1024 + 1),
        'audio/wav',
        'zh',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      speech.transcribe(
        Buffer.from('wav'),
        'audio/wav',
        '../x',
        new AbortController().signal,
      ),
    ).rejects.toThrow('中文');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('serializes inference and forwards cancellation', async () => {
    let started!: () => void;
    const start = new Promise<void>((r) => {
      started = r;
    });
    const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/health')) {
        return Promise.resolve(
          new Response('{"status":"ok"}', { status: 200 }),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        started();
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    });
    const speech = new LocalSpeech(
      'http://whisper:8000/v1',
      fetcher as unknown as typeof fetch,
    );
    const controller = new AbortController();
    const first = speech.transcribe(
      Buffer.from('x'),
      'audio/wav',
      'en',
      controller.signal,
    );
    const rejected = expect(first).rejects.toThrow();
    await start;
    await expect(
      speech.transcribe(
        Buffer.from('x'),
        'audio/wav',
        'en',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 429 });
    controller.abort();
    await rejected;
  });

  it('supports API mode for independent faster-whisper service', async () => {
    const mockFetcher = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      if (urlStr.includes('/audio/transcriptions')) {
        return new Response(
          JSON.stringify({ text: '測試獨立 Whisper 容器識別成功。' }),
          { status: 200 },
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const speech = new LocalSpeech(
      'http://whisper:8000/v1',
      mockFetcher as unknown as typeof fetch,
    );

    const status = await speech.status();
    expect(status.available).toBe(true);
    expect(status.reason).toContain('独立 Whisper');

    const result = await speech.transcribe(
      Buffer.from('test-audio'),
      'audio/wav',
      'zh',
      new AbortController().signal,
    );
    // Prompt guidance must not rewrite the model's response.
    expect(result).toBe('測試獨立 Whisper 容器識別成功。');
    expect(mockFetcher).toHaveBeenCalledWith(
      'http://whisper:8000/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('API mode handles server failure and empty transcript', async () => {
    const failFetcher = vi.fn(async () => {
      return new Response('Service Unavailable', { status: 503 });
    });
    const speech = new LocalSpeech(
      'http://whisper:8000/v1',
      failFetcher as unknown as typeof fetch,
    );

    const status = await speech.status();
    expect(status.available).toBe(false);

    const emptyFetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/health'))
        return new Response('{"status":"ok"}', { status: 200 });
      return new Response(JSON.stringify({ text: '' }), { status: 200 });
    });
    const emptySpeech = new LocalSpeech(
      'http://whisper:8000/v1',
      emptyFetcher as unknown as typeof fetch,
    );
    await expect(
      emptySpeech.transcribe(
        Buffer.from('audio'),
        'audio/wav',
        'zh',
        new AbortController().signal,
      ),
    ).rejects.toThrow('没有识别到文字');
    await expect(
      emptySpeech.transcribe(
        Buffer.from('audio'),
        'audio/wav',
        'zh',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 400, code: 'no-speech' });
  });

  it.each([
    ['zh', undefined, '以下是简体中文的语音转写。'],
    ['zh', '   ', '以下是简体中文的语音转写。'],
    ['zh', '体素世界，建造房子。', '体素世界，建造房子。'],
    ['en', undefined, null],
    ['en', 'Voxel world.', 'Voxel world.'],
  ])(
    'API mode chooses the prompt for %s with custom hint %s',
    async (language, prompt, expected) => {
      const fetcher = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.method === 'POST') {
            expect((init.body as FormData).get('prompt')).toBe(expected);
            return new Response(JSON.stringify({ text: '原樣輸出' }));
          }
          return new Response('{}');
        },
      );
      const speech = new LocalSpeech('http://whisper:8000/v1', fetcher);
      const settings =
        prompt === undefined
          ? undefined
          : {
              model: 'default',

              temperature: 0,
              prompt,
            };
      expect(
        await speech.transcribe(
          Buffer.from('audio'),
          'audio/wav',
          language!,
          new AbortController().signal,
          settings,
        ),
      ).toBe('原樣輸出');
    },
  );

  it.each([
    ['audio/webm;codecs=opus', 'audio/webm', 'audio.webm'],
    ['audio/mp4', 'audio/mp4', 'audio.m4a'],
  ])(
    'preserves the upload media type and extension for %s in API mode',
    async (type, mime, name) => {
      const fetcher = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.method === 'POST') {
            const file = (init.body as FormData).get('file') as File;
            expect(file.type).toBe(mime);
            expect(file.name).toBe(name);
            return new Response(JSON.stringify({ text: 'hello' }));
          }
          return new Response('{}');
        },
      );
      const speech = new LocalSpeech('http://whisper:8000/v1', fetcher);
      expect(
        await speech.transcribe(
          Buffer.from('audio'),
          type,
          'en',
          new AbortController().signal,
        ),
      ).toBe('hello');
    },
  );
});
