import express from 'express';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
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
import type { CommandRunner } from '../src/core/audio/command';
import type { SherpaOfflineModule } from '../src/modules/asr/engines/sense-voice/sense-voice.adapter';
import { TestAsrService } from './helpers/memory-storage';

/**
 * 整个文件只验证 SenseVoice 的跨层契约：HTTP 路由 → 领域校验 → 服务仓储 → 引擎适配器。
 * 引擎替身与临时模型目录都在 hoisted 中准备，因为共享单例在模块导入期就已构造。
 */
const mocked = vi.hoisted(() => ({
  root: `${(process.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')}/sense-voice-it-${process.pid}`,
  pack: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-it',
  configs: [] as (string | undefined)[],
  waveforms: [] as { samples: Float32Array; sampleRate: number }[],
  text: '你好世界',
  store: undefined as unknown as TestAsrService,
}));

vi.mock('../src/modules/tts', () => ({
  createDefaultSpeechStatus: () => async () => ({
    available: false,
    reason: '请安装 Piper 模型。',
  }),
}));

vi.mock('../src/modules/asr/engines', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/modules/asr/engines')>();
  // sherpa-onnx 替身：记录语言切换与解码输入，返回固定文本。
  const sherpa = async () => ({
    OfflineRecognizer: {
      createAsync: async (config: {
        modelConfig?: { senseVoice?: { language?: string } };
      }) => {
        mocked.configs.push(config.modelConfig?.senseVoice?.language);
        return {
          setConfig: (next: {
            modelConfig?: { senseVoice?: { language?: string } };
          }) => mocked.configs.push(next.modelConfig?.senseVoice?.language),
          createStream: () => ({
            acceptWaveform: (waveform: {
              samples: Float32Array;
              sampleRate: number;
            }) => mocked.waveforms.push(waveform),
          }),
          decodeAsync: async () => ({ text: mocked.text }),
        };
      },
    },
  });
  const neverRun = (() => {
    throw new Error('浏览器快照已是 16 kHz WAV，不应调用 FFmpeg。');
  }) as unknown as CommandRunner;
  return {
    ...actual,
    // 用临时模型目录替换共享单例，避免测试加载真实的 ONNX 会话。
    senseVoiceSpeech: new actual.SenseVoiceAdapter(
      mocked.root,
      2,
      neverRun,
      sherpa as unknown as () => Promise<SherpaOfflineModule>,
    ),
  };
});

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

describe('SenseVoice offline ASR over the ASR HTTP boundary', () => {
  let server: Server, base: string;

  beforeAll(async () => {
    const dir = join(mocked.root, mocked.pack);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tokens.txt'), '开 1\n饭 2\n');
    await writeFile(
      join(dir, 'model.int8.onnx'),
      Buffer.alloc(1024 * 1024 + 1),
    );
  });
  afterAll(async () => {
    await rm(mocked.root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    // auto + 已安装模型是默认部署形态：未保存配置的转写也应走本地 SenseVoice。
    vi.stubEnv('ASR_PROVIDER', 'auto');
    vi.stubEnv('ASR_MODEL_DIR', mocked.root);
    vi.stubEnv('WEB_ORIGIN', origin);
    mocked.configs.length = 0;
    mocked.waveforms.length = 0;
    mocked.text = '你好世界';
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

  it('lists installed packs and reports the offline engine as ready', async () => {
    const response = await json('/voice/capabilities');
    expect(response.status).toBe(200);
    const body = await response.json();
    // 模型列表是全局信息，控制台在还没保存配置时也要能选到。
    expect(body.senseVoiceModels).toContain(mocked.pack);
    expect(body.local).toMatchObject({ available: true });
    expect(body.local.reason).toContain('SenseVoice');
  });

  it('saves a keyless profile, assigns it to chat and transcodes browser WAV', async () => {
    const created = await json('/voice/asr/services', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'sense-voice',
        name: '本地中文识别',
        model: 'default',
        language: 'zh',
      }),
    });
    expect(created.status).toBe(201);
    const service = await created.json();
    expect(service).toMatchObject({
      provider: 'sense-voice',
      model: 'default',
      language: 'zh',
    });
    // 本地引擎不持有密钥，视图也不能凭空出现 hasApiKey。
    expect(service).not.toHaveProperty('apiKey');
    expect(service).not.toHaveProperty('hasApiKey');

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
    // 快照原样送入解码器：16 kHz、无 FFmpeg、使用配置里的中文。
    expect(mocked.waveforms[0]).toMatchObject({ sampleRate: 16000 });
    expect(mocked.waveforms[0].samples.length).toBe(16000);
    expect(mocked.configs.at(-1)).toBe('zh');
  });

  it('routes requests without a serviceId through the installed pack', async () => {
    // 未保存配置时跟随 ASR_PROVIDER=auto，命中已安装的模型包。
    const english = await transcribe('language=en');
    expect(english.status).toBe(200);
    expect(await english.json()).toEqual({ text: '你好世界' });
    expect(mocked.configs.at(-1)).toBe('en');

    // auto 在游戏里等价于中文；同一个 ONNX 会话只切换语言条件，不重建识别器。
    const auto = await transcribe('language=auto');
    expect(auto.status).toBe(200);
    expect(await auto.json()).toEqual({ text: '你好世界' });
    expect(mocked.configs.at(-1)).toBe('zh');
    expect(mocked.waveforms).toHaveLength(2);
  });

  it('rejects unsupported languages, invalid packs and clip assignment', async () => {
    const invalidModel = await json('/voice/asr/services', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'sense-voice',
        name: '越界模型',
        model: '../etc',
        language: 'zh',
      }),
    });
    expect(invalidModel.status).toBe(400);
    expect((await invalidModel.json()).error).toContain('SenseVoice 模型');

    const saved = await json('/voice/asr/services', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'sense-voice',
        name: '本地识别',
        model: 'default',
        language: 'zh',
      }),
    });
    const service = await saved.json();

    // 语音消息转文字仍然只支持 Whisper，本地引擎不能被错误分配。
    const clip = await json('/voice/asr/assignments/clip', {
      method: 'PUT',
      body: JSON.stringify({ serviceId: service.id }),
    });
    expect(clip.status).toBe(400);
    expect((await clip.json()).error).toContain('Whisper');

    const language = await transcribe(`serviceId=${service.id}&language=fr`);
    expect(language.status).toBe(400);
    expect(await language.json()).toEqual({
      error: '只支持自动、中文或英文识别。',
    });
  });

  it('keeps the ASR service list free of secrets', async () => {
    await json('/voice/asr/services', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'sense-voice',
        name: '本地识别',
        model: 'default',
        language: 'zh',
      }),
    });
    const response = await json('/voice/asr/services');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('hasApiKey');
    expect(JSON.stringify(body)).not.toContain('apiKey');
  });
});
