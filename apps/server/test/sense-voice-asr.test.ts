import express from 'express';
import { createServer, type Server } from 'node:http';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { TestAsrService } from './helpers/memory-storage';

/**
 * 跨层契约：HTTP 路由 → 领域校验 → 服务仓储 → 外部 SenseVoice 适配器。
 * 上游用一个真实的本地 HTTP 服务代替容器，验证请求字段、鉴权与错误映射。
 */
const mocked = vi.hoisted(() => ({
  store: undefined as unknown as TestAsrService,
}));

vi.mock('../src/modules/tts', () => ({
  createDefaultSpeechStatus: () => async () => ({
    available: false,
    reason: '请安装 Piper 模型。',
  }),
}));

vi.mock('../src/modules/asr/services/asr.service', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../src/modules/asr/services/asr.service')
    >();
  return {
    ...actual,
    asrService: {
      list: () => mocked.store.list(),
      models: (value: unknown, signal?: AbortSignal) =>
        mocked.store.models(value, signal),
      assignments: () => mocked.store.assignments(),
      assign: (use: unknown, id: unknown) => mocked.store.assign(use, id),
      get: (id: string) => mocked.store.get(id),
      acquire: (id: string) => mocked.store.acquire(id),
      save: (input: unknown, id?: string) => mocked.store.save(input, id),
      remove: (id: string) => mocked.store.remove(id),
    },
  };
});

import { createAsrRouter } from '../src/modules/asr/routes/asr.routes';

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

const origin = 'http://127.0.0.1:5199';

type UpstreamCall = {
  url: string;
  authorization?: string;
  body: string;
};

describe('SenseVoice external ASR over the ASR HTTP boundary', () => {
  let server: Server, base: string;
  let upstream: Server, upstreamBase: string;
  let calls: UpstreamCall[];

  beforeAll(async () => {
    calls = [];
    const app = express();
    app.use((req, res, next) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        calls.push({
          url: req.url,
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        next();
      });
    });
    app.get('/health', (_req, res) => res.status(200).end());
    app.get('/v1/models', (_req, res) =>
      res.json({ data: [{ id: 'iic/SenseVoiceSmall' }] }),
    );
    app.post('/v1/audio/transcriptions', (_req, res) =>
      res.json({ text: '你好世界' }),
    );
    upstream = createServer(app);
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    upstreamBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
  });
  afterAll(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  beforeEach(async () => {
    // auto + 配置了外部地址是 SenseVoice 的典型部署形态。
    vi.stubEnv('ASR_PROVIDER', 'auto');
    vi.stubEnv('SENSE_VOICE_API_URL', upstreamBase);
    vi.stubEnv('WEB_ORIGIN', origin);
    calls.length = 0;
    mocked.store = new TestAsrService();
    const app = express();
    app.use(createAsrRouter());
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // 统一带上 Origin，模拟控制台页面发起的请求，跨站校验才能按真实路径生效。
  const json = (path: string, init?: RequestInit) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });

  // 以 16 kHz WAV 提交转写，与浏览器录音快照的格式保持一致。
  const transcribe = (query: string) =>
    fetch(`${base}/voice/transcribe?${query}`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'audio/wav' },
      body: pcmWav(),
    });

  const createService = (extra: Record<string, unknown> = {}) =>
    json('/voice/asr/services', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'sense-voice',
        name: '外部识别',
        model: 'iic/SenseVoiceSmall',
        language: 'zh',
        ...extra,
      }),
    });

  it('lists upstream models and reports readiness', async () => {
    const response = await json('/voice/capabilities');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.senseVoiceModels).toEqual(['iic/SenseVoiceSmall']);
    expect(body.local).toMatchObject({ available: true });
    expect(body.local.reason).toContain('外部容器');
  });

  it('saves an external profile, hides its key and transcribes through it', async () => {
    const created = await createService({
      baseUrl: upstreamBase,
      apiKey: 'secret',
    });
    expect(created.status).toBe(201);
    const service = await created.json();
    expect(service).toMatchObject({
      provider: 'sense-voice',
      model: 'iic/SenseVoiceSmall',
      language: 'zh',
      baseUrl: upstreamBase,
      hasApiKey: true,
    });
    // 密钥只留在服务端，列表与创建响应都不能回显明文。
    expect(service).not.toHaveProperty('apiKey');

    const assigned = await json(`/voice/asr/assignments/chat`, {
      method: 'PUT',
      body: JSON.stringify({ serviceId: service.id }),
    });
    expect(assigned.status).toBe(200);
    expect(await assigned.json()).toMatchObject({
      chat: { id: service.id, provider: 'sense-voice' },
    });

    const response = await transcribe(`serviceId=${service.id}&language=zh`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: '你好世界' });

    const post = calls.find((call) =>
      call.url.endsWith('/audio/transcriptions'),
    )!;
    expect(post.authorization).toBe('Bearer secret');
    expect(post.body).toContain('iic/SenseVoiceSmall');
    expect(post.body).toContain('name="language"');
    expect(post.body).toContain('zh');
    // 16 kHz WAV 快照原样转发，无需 FFmpeg。
    expect(post.body).toContain('RIFF');
  });

  it('routes requests without a serviceId through SENSE_VOICE_API_URL', async () => {
    const response = await transcribe('language=auto');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: '你好世界' });
    const post = calls.find((call) =>
      call.url.endsWith('/audio/transcriptions'),
    )!;
    // auto 交给外部模型检测，不发送 language 字段。
    expect(post.body).not.toContain('name="language"');
  });

  it('rejects invalid models and languages before calling upstream', async () => {
    const invalidModel = await createService({ model: '../etc' });
    expect(invalidModel.status).toBe(400);
    expect((await invalidModel.json()).error).toContain('SenseVoice 模型 ID');

    const saved = await createService();
    const service = await saved.json();
    const language = await transcribe(`serviceId=${service.id}&language=fr`);
    expect(language.status).toBe(400);
    expect(await language.json()).toEqual({
      error: '只支持自动、中文或英文识别。',
    });
    expect(
      calls.some((call) => call.url.endsWith('/audio/transcriptions')),
    ).toBe(false);
  });

  it('allows SenseVoice for recorded voice and keeps the list secret-free', async () => {
    const saved = await createService({
      baseUrl: upstreamBase,
      apiKey: 'secret',
    });
    const service = await saved.json();
    // 语音消息与 Whisper 一样走服务器音频接口，SenseVoice 也能被分配。
    const clip = await json('/voice/asr/assignments/clip', {
      method: 'PUT',
      body: JSON.stringify({ serviceId: service.id }),
    });
    expect(clip.status).toBe(200);
    expect(await clip.json()).toMatchObject({
      clip: { id: service.id, provider: 'sense-voice' },
    });

    const response = await json('/voice/asr/services');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(JSON.stringify(body)).not.toContain('"apiKey"');
  });
});
