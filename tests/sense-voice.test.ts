import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSenseVoiceModels,
  resolveSenseVoiceModel,
  validateSenseVoiceSettings,
} from '../apps/server/src/modules/audio/asr/sense-voice-models';
import {
  SenseVoiceSpeech,
  type SherpaOfflineModule,
} from '../apps/server/src/modules/audio/asr/sense-voice-speech';
import { SpeechRouter } from '../apps/server/src/modules/audio/asr/speech-provider';
import { AsrSettingsStore } from '../apps/server/src/modules/audio/asr/asr-settings';
import { DEFAULT_SENSE_VOICE_ASR } from '@voxel/shared';
import { AppError } from '../apps/server/src/common/errors';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A SenseVoice pack counts only when both the graph and its token table exist. */
async function modelRoot(withPack = true) {
  const root = await mkdtemp(join(tmpdir(), 'sense-voice-root-'));
  roots.push(root);
  if (withPack) {
    const dir = join(root, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-test');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tokens.txt'), '开 1\n饭 2\n');
    await writeFile(
      join(dir, 'model.int8.onnx'),
      Buffer.alloc(1024 * 1024 + 1),
    );
  }
  return root;
}

/** 16 kHz mono PCM16 WAV with an audible tone, as the browser snapshots produce. */
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

type Session = {
  configs: (string | undefined)[];
  waveforms: { samples: Float32Array; sampleRate: number }[];
  text: string;
  busy: number;
  overlapped: boolean;
  delayMs: number;
};
const session = (text = '你好世界'): Session => ({
  configs: [],
  waveforms: [],
  text,
  busy: 0,
  overlapped: false,
  delayMs: 0,
});

/** Double for sherpa-onnx that records the language switches and decodes. */
function fakeSherpa(state: Session): () => Promise<SherpaOfflineModule> {
  return async () => ({
    OfflineRecognizer: {
      createAsync: async (config) => {
        state.configs.push(config.modelConfig?.senseVoice?.language);
        return {
          setConfig: (next) =>
            state.configs.push(next.modelConfig?.senseVoice?.language),
          createStream: () => ({
            acceptWaveform: (waveform) => state.waveforms.push(waveform),
          }),
          decodeAsync: async () => {
            state.busy++;
            if (state.busy > 1) state.overlapped = true;
            if (state.delayMs)
              await new Promise((resolve) =>
                setTimeout(resolve, state.delayMs),
              );
            state.busy--;
            return { text: state.text };
          },
        };
      },
    },
  });
}

const engine = (root: string, state: Session, runner?: () => Promise<void>) =>
  new SenseVoiceSpeech(
    root,
    2,
    'ffmpeg',
    (runner ??
      ((): never => {
        throw new Error('FFmpeg must not run for browser WAV');
      })) as never,
    fakeSherpa(state),
  );

it('lists only complete SenseVoice packs and explains a missing model', async () => {
  const root = await modelRoot();
  const models = await listSenseVoiceModels(root);
  expect(models.map((model) => model.name)).toEqual([
    'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-test',
  ]);
  expect((await resolveSenseVoiceModel('default', root)).model).toContain(
    'model.int8.onnx',
  );
  await expect(
    resolveSenseVoiceModel('sherpa-onnx-sense-voice-missing', root),
  ).rejects.toThrow('不可用');
  const empty = await modelRoot(false);
  expect(await listSenseVoiceModels(empty)).toEqual([]);
  await expect(resolveSenseVoiceModel('default', empty)).rejects.toThrow(
    '未安装本地 SenseVoice 模型',
  );
  expect(() =>
    validateSenseVoiceSettings({ model: '../etc', language: 'zh' }),
  ).toThrow('SenseVoice 模型');
  expect(() =>
    validateSenseVoiceSettings({
      ...DEFAULT_SENSE_VOICE_ASR,
      language: 'fr' as never,
    }),
  ).toThrow('识别语言');
});

it('keeps a keyless SenseVoice profile in the saved ASR services', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sense-voice-store-'));
  roots.push(dir);
  const store = new AsrSettingsStore(join(dir, 'asr.json'));
  await store.load();
  const saved = await store.save({
    ...DEFAULT_SENSE_VOICE_ASR,
    provider: 'sense-voice',
    name: '本地中文识别',
  });
  expect(saved).toMatchObject({ provider: 'sense-voice', language: 'zh' });
  expect(JSON.stringify(store.list())).not.toContain('hasApiKey');
  await expect(
    store.save({ ...saved, provider: 'whisper' } as never, saved.id),
  ).rejects.toThrow('不能更改类型');
  const restored = new AsrSettingsStore(store.path);
  await restored.load();
  expect(restored.get(saved.id)).toMatchObject({
    provider: 'sense-voice',
    model: 'default',
  });
});

it('transcribes 16 kHz browser WAV without FFmpeg and defaults to Chinese', async () => {
  const root = await modelRoot(),
    state = session();
  const speech = engine(root, state);
  const text = await speech.transcribe(
    pcmWav(),
    'audio/wav',
    'zh',
    new AbortController().signal,
  );
  expect(text).toBe('你好世界');
  expect(state.waveforms[0].sampleRate).toBe(16000);
  expect(state.waveforms[0].samples.length).toBe(16000);
  expect(state.waveforms[0].samples[1]).toBeGreaterThan(0);
  // One session for every sentence, loaded with the requested language.
  expect(state.configs).toEqual(['zh']);
  const status = await speech.status();
  expect(status.available).toBe(true);
  expect(status.reason).toContain('SenseVoice');
});

it('applies the saved language, collapses whitespace and rejects useless results', async () => {
  const root = await modelRoot(),
    state = session('你好   世界'),
    speech = engine(root, state),
    signal = new AbortController().signal;
  expect(
    await speech.transcribe(pcmWav(), 'audio/wav', 'en', signal, {
      model: 'default',
      language: 'en',
    }),
  ).toBe('你好 世界');
  expect(state.configs).toEqual(['en']);
  state.text = '   ';
  await expect(
    speech.transcribe(pcmWav(), 'audio/wav', 'zh', signal),
  ).rejects.toMatchObject({ code: 'no-speech', status: 400 });
  expect(state.configs).toEqual(['en', 'zh']);
  state.text = '你好   自动';
  expect(
    await speech.transcribe(pcmWav(), 'audio/wav', 'zh', signal, {
      model: 'default',
      language: 'auto',
    }),
  ).toBe('你好 自动');
  expect(state.configs).toEqual(['en', 'zh', 'auto']);
  state.text = '字'.repeat(241);
  await expect(
    speech.transcribe(pcmWav(), 'audio/wav', 'zh', signal),
  ).rejects.toThrow('请分成更短的句子');
  state.text = '你好';
  await expect(
    speech.transcribe(Buffer.from('x'), 'audio/mpeg', 'zh', signal),
  ).rejects.toThrow('音频格式或大小无效');
});

it('decodes one sentence at a time so the shared session is never overlapped', async () => {
  const root = await modelRoot(),
    state = session(),
    speech = engine(root, state);
  state.delayMs = 10;
  const signal = new AbortController().signal;
  await Promise.all([
    speech.transcribe(pcmWav(), 'audio/wav', 'zh', signal),
    speech.transcribe(pcmWav(), 'audio/wav', 'zh', signal),
    speech.transcribe(pcmWav(), 'audio/wav', 'en', signal),
  ]);
  expect(state.overlapped).toBe(false);
  expect(state.waveforms).toHaveLength(3);
});

it('converts other containers with FFmpeg before decoding', async () => {
  const root = await modelRoot(),
    state = session(),
    runner = vi.fn(async () => undefined);
  const speech = engine(root, state, runner);
  await expect(
    speech.normalize(
      Buffer.from('webm bytes'),
      'audio/webm',
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(runner).toHaveBeenCalled();
});

it('routes saved profiles to their engine and follows the model presence for chat voice', async () => {
  const root = await modelRoot();
  const whisper = {
    status: vi.fn(async () => ({ available: true, reason: 'whisper' })),
    normalize: vi.fn(),
    transcribe: vi.fn(),
  };
  const senseVoice = {
    status: vi.fn(async () => ({ available: true, reason: 'sense-voice' })),
    normalize: vi.fn(),
    transcribe: vi.fn(),
  };
  const auto = new SpeechRouter({
    whisper,
    senseVoice,
    models: () => listSenseVoiceModels(root),
  });
  expect(await auto.default.status()).toEqual({
    available: true,
    reason: 'sense-voice',
  });
  expect(auto.engineFor({ provider: 'whisper' })).toBe(whisper);
  expect(auto.engineFor({ provider: 'sense-voice' })).toBe(senseVoice);
  expect(auto.engineFor()).toBe(auto.default);
  expect(() => auto.engineFor({ provider: 'bailian' })).toThrow(AppError);
  const none = await mkdtemp(join(tmpdir(), 'sense-voice-none-'));
  roots.push(none);
  const fallback = new SpeechRouter({
    whisper,
    senseVoice,
    models: () => listSenseVoiceModels(none),
  });
  expect(await fallback.default.status()).toEqual({
    available: true,
    reason: 'whisper',
  });
  const forced = new SpeechRouter({
    whisper,
    senseVoice,
    provider: 'whisper',
    models: () => listSenseVoiceModels(root),
  });
  expect(await forced.default.status()).toEqual({
    available: true,
    reason: 'whisper',
  });
});
