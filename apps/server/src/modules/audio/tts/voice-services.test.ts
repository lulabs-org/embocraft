import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';

import { join } from 'node:path';

import { tmpdir } from 'node:os';

import { VoiceServiceStore, validateVoiceService } from './voice-services';

import { PiperTts } from '../services/tts/piper.service';

import { DEFAULT_PIPER_MODEL, PIPER_MODELS } from '@voxel/shared';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'voice-services-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const local = (name = 'Local', voice = '') => ({
  name,
  type: 'piper',
  model: voice === 'Samantha' ? PIPER_MODELS[1].id : DEFAULT_PIPER_MODEL,
  voice: '',
  speed: 1,
});

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

it('persists multiple configurations privately, masks credentials, and preserves a blank key on edit', async () => {
  const store = new VoiceServiceStore(join(dir, 'voices.json'));
  await store.load();
  const cloud = await store.save(remote);
  const localVoice = await store.save(local('中文', 'Tingting'));
  expect(JSON.stringify(store.list())).not.toContain(remote.apiKey);
  expect(cloud.hasApiKey).toBe(true);
  await store.save({ ...cloud, apiKey: '', name: 'Renamed' }, cloud.id);
  expect(store.get(cloud.id).apiKey).toBe(remote.apiKey);
  const restored = new VoiceServiceStore(store.path);
  await restored.load();
  expect(restored.list()).toHaveLength(3);
  expect(restored.get(localVoice.id).model).toBe(DEFAULT_PIPER_MODEL);
  expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(store.path, 'utf8'))).toHaveLength(3);
});

it('rejects credential reuse for a different endpoint and invalid configuration', () => {
  const saved = validateVoiceService(remote);
  expect(() =>
    validateVoiceService(
      { ...remote, baseUrl: 'https://other.example/v1', apiKey: '' },
      saved,
    ),
  ).toThrow('重新填写');
  for (const baseUrl of [
    'http://remote.example/v1',
    'https://user:password@example.com',
    'file:///tmp/a',
    'https://example.com?key=x',
  ])
    expect(() => validateVoiceService({ ...remote, baseUrl })).toThrow();
  expect(() => validateVoiceService({ ...local(), speed: NaN })).toThrow();
  expect(() => validateVoiceService({ ...remote, type: 'bailian' })).toThrow(
    '官方接口',
  );
});

it('migrates old local services once, keeps IDs and speeds, and backs up the original', async () => {
  const path = join(dir, 'voices.json');
  const original = JSON.stringify([
    {
      id: 'local-default',
      name: 'macOS 系统语音',
      type: 'local',
      voice: 'Tingting',
      speed: 0.8,
    },
    {
      id: 'custom',
      name: 'My voice',
      type: 'local',
      voice: 'Samantha',
      speed: 1.2,
    },
  ]);
  await writeFile(path, original);
  const store = new VoiceServiceStore(path);
  await store.load();
  expect(store.get('local-default')).toMatchObject({
    type: 'piper',
    name: 'Piper 本地语音',
    voice: '',
    model: DEFAULT_PIPER_MODEL,
    speed: 0.8,
  });
  expect(store.get('custom')).toMatchObject({ name: 'My voice', speed: 1.2 });
  store.bind('actor', 'custom');
  expect(await readFile(`${path}.pre-piper.bak`, 'utf8')).toBe(original);
  await store.load();
  expect(await readFile(`${path}.pre-piper.bak`, 'utf8')).toBe(original);
  expect(() => validateVoiceService({ ...local(), type: 'local' })).toThrow();
  expect(() =>
    validateVoiceService({ ...local(), model: 'arbitrary/model' }),
  ).toThrow();
});

it('rejects deletion of referenced services and validates bindings before changing them', async () => {
  const store = new VoiceServiceStore(join(dir, 'voices.json'));
  await store.load();
  await expect(store.remove('local-default', () => true)).rejects.toThrow(
    '引用',
  );
  store.bind('actor', 'local-default');
  await expect(store.remove('local-default', () => false)).rejects.toThrow(
    '引用',
  );
  expect(() => store.bind('actor', 'missing')).toThrow();
  store.unbind('actor');
  await store.remove('local-default', () => false);
  expect(store.list()).toEqual([]);
});

it('keeps unmanaged world clients on local TTS even if the initial profile becomes a cloud service', async () => {
  const store = new VoiceServiceStore(join(dir, 'voices.json'));
  await store.load();
  await store.save(remote, 'local-default');
  expect(store.forActor('unmanaged-client')).toBeInstanceOf(PiperTts);
});

it('routes previews and different actors through the saved voice and speed, never by a client payload', async () => {
  const calls: string[] = [];
  const store = new VoiceServiceStore(join(dir, 'voices.json'), (config) => ({
    synthesize: async (text) => {
      calls.push(`${config.model}:${config.speed}:${text}`);
      return { bytes: wav(), durationMs: 1000 };
    },
  }));
  await store.load();
  const a = await store.save({ ...local('A', 'Tingting'), speed: 0.8 });
  const b = await store.save(local('B', 'Samantha'));
  store.bind('a', a.id);
  store.bind('b', b.id);
  await store.synthesize(a.id, 'Preview', new AbortController().signal);
  await store.forActor('a').synthesize('Agent A', new AbortController().signal);
  await store.forActor('b').synthesize('Agent B', new AbortController().signal);
  expect(calls).toEqual([
    `${DEFAULT_PIPER_MODEL}:0.8:Preview`,
    `${DEFAULT_PIPER_MODEL}:0.8:Agent A`,
    `${PIPER_MODELS[1].id}:1:Agent B`,
  ]);
  store.bind('b', '');
  await expect(
    store.forActor('b').synthesize('Disabled', new AbortController().signal),
  ).rejects.toThrow();
});

it('cancels previews and bounds concurrent synthesis', async () => {
  const pending: (() => void)[] = [];
  const store = new VoiceServiceStore(join(dir, 'voices.json'), () => ({
    synthesize: async () => {
      await new Promise<void>((resolve) => pending.push(resolve));
      return { bytes: wav(), durationMs: 1000 };
    },
  }));
  await store.load();
  const abort = new AbortController();
  const first = store.synthesize('local-default', 'one', abort.signal);
  const second = store.synthesize(
    'local-default',
    'two',
    new AbortController().signal,
  );
  await expect(
    store.synthesize('local-default', 'three', new AbortController().signal),
  ).rejects.toThrow('繁忙');
  abort.abort();
  pending.forEach((resolve) => resolve());
  await expect(first).rejects.toThrow();
  await second;
});

it('persists browser profiles without credentials and never runs server synthesis', async () => {
  const factory = vi.fn();
  const store = new VoiceServiceStore(join(dir, 'browser.json'), factory);
  await store.load();
  const saved = await store.save({
    ...remote,
    type: 'browser',
    voice: 'Shelley (中文（中国大陆）)',
    voiceLanguage: 'zh-CN',
  });
  expect(saved).toMatchObject({
    type: 'browser',
    baseUrl: '',
    model: '',
    hasApiKey: false,
  });
  store.bind('ai', saved.id);
  expect(store.forActor('ai').browserVoice).toEqual({
    voice: saved.voice,
    speed: 1,
    voiceLanguage: 'zh-CN',
  });
  await expect(
    store.synthesize(saved.id, '你好', new AbortController().signal),
  ).rejects.toThrow('浏览器');
  expect(factory).not.toHaveBeenCalled();
  const restored = new VoiceServiceStore(store.path);
  await restored.load();
  expect(restored.get(saved.id).voiceLanguage).toBe('zh-CN');
});
