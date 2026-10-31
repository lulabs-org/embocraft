import { afterEach, expect, it, vi } from 'vitest';
import { TestVoiceServiceStore as VoiceServiceStore } from '../../../../test/helpers/memory-storage';

import { validateVoiceService } from './voice-service-store';

import { PiperTts } from '../services/tts/piper.service';

import { DEFAULT_PIPER_MODEL, PIPER_MODELS } from '@voxel/shared';

const local = (name = 'Local', voice = '') => ({
  name,
  type: 'speaches',
  model: voice === 'Samantha' ? PIPER_MODELS[1].id : DEFAULT_PIPER_MODEL,
  voice: '',
  speed: 1,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('loads legacy Piper profiles as Speaches without changing IDs, names or models', async () => {
  const store = new VoiceServiceStore();
  store.persistence.value = JSON.parse(
    JSON.stringify([
      {
        ...local('My Piper voice', 'Samantha'),
        type: 'piper',
        id: 'existing-voice',
        baseUrl: '',
        apiKey: '',
      },
    ]),
  );
  await store.load();
  expect(store.list()[0]).toMatchObject({
    id: 'existing-voice',
    name: 'My Piper voice',
    type: 'speaches',
    model: PIPER_MODELS[1].id,
    baseUrl: '',
  });
  store.bind('existing-agent', 'existing-voice');
  await store.save({ ...store.list()[0], speed: 0.8 }, 'existing-voice');
  const restored = new VoiceServiceStore(store.persistence);
  await restored.load();
  expect(restored.get('existing-voice')).toMatchObject({
    type: 'speaches',
    speed: 0.8,
  });
});

it('accepts private Speaches endpoints and optional credentials while rejecting unsafe URL forms', () => {
  for (const baseUrl of [
    '',
    'http://speech:8000/v1/',
    'http://192.168.1.20:8000/v1',
    'https://speech.example/v1',
  ]) {
    expect(validateVoiceService({ ...local(), baseUrl })).toMatchObject({
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey: '',
    });
  }
  for (const baseUrl of [
    'file:///tmp/a',
    'ftp://speech/v1',
    'http://user:key@speech/v1',
    'http://speech/v1?key=x',
    'http://speech/v1#fragment',
  ]) {
    expect(() => validateVoiceService({ ...local(), baseUrl })).toThrow();
  }
  const saved = validateVoiceService({ ...local(), apiKey: 'test-key' });
  expect(validateVoiceService(local(), saved).apiKey).toBe('test-key');
  expect(() =>
    validateVoiceService(
      { ...local(), baseUrl: 'http://other:8000/v1' },
      saved,
    ),
  ).toThrow('重新填写');
});

it('persists the Speaches endpoint and uses it for both previews and bound actors', async () => {
  vi.stubEnv('SPEECH_API_URL', 'http://default-speech:8000/v1');
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(wav()));
  vi.stubGlobal('fetch', request);
  const store = new VoiceServiceStore();
  await store.load();
  const selected = await store.save({
    ...local(),
    model: 'vendor/new-tts',
    voice: 'speaker:2',
    baseUrl: 'http://custom-speech:8000/v1///',
    apiKey: 'speaches-test-key',
  });
  expect(selected.baseUrl).toBe('http://custom-speech:8000/v1');
  expect(JSON.stringify(selected)).not.toContain('speaches-test-key');
  const restored = new VoiceServiceStore(store.persistence);
  await restored.load();
  await restored.save({ ...selected, apiKey: '' }, selected.id);
  restored.bind('agent', selected.id);
  await restored.synthesize(
    selected.id,
    'Preview',
    new AbortController().signal,
  );
  await restored
    .forActor('agent')
    .synthesize('Agent', new AbortController().signal);
  expect(request).toHaveBeenCalledTimes(2);
  for (const [url, init] of request.mock.calls) {
    expect(url).toBe('http://custom-speech:8000/v1/audio/speech');
    expect(init).toMatchObject({
      redirect: 'error',
      headers: { Authorization: 'Bearer speaches-test-key' },
    });
    expect(JSON.parse(init!.body as string)).toMatchObject({
      model: 'vendor/new-tts',
      voice: 'speaker:2',
    });
  }
  await restored.synthesize(
    'local-default',
    'Default',
    new AbortController().signal,
  );
  expect(request.mock.lastCall?.[0]).toBe(
    'http://default-speech:8000/v1/audio/speech',
  );
  expect(request.mock.lastCall?.[1]?.headers).not.toHaveProperty(
    'Authorization',
  );
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
  const store = new VoiceServiceStore();
  await store.load();
  const cloud = await store.save(remote);
  const localVoice = await store.save(local('中文', 'Tingting'));
  expect(JSON.stringify(store.list())).not.toContain(remote.apiKey);
  expect(cloud.hasApiKey).toBe(true);
  await store.save({ ...cloud, apiKey: '', name: 'Renamed' }, cloud.id);
  expect(store.get(cloud.id).apiKey).toBe(remote.apiKey);
  const restored = new VoiceServiceStore(store.persistence);
  await restored.load();
  expect(restored.list()).toHaveLength(3);
  expect(restored.get(localVoice.id).model).toBe(DEFAULT_PIPER_MODEL);
  expect(await store.persistence.load()).toHaveLength(3);
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

it('rejects deletion of referenced services and validates bindings before changing them', async () => {
  const store = new VoiceServiceStore();
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
  const store = new VoiceServiceStore();
  await store.load();
  await store.save(remote, 'local-default');
  expect(store.forActor('unmanaged-client')).toBeInstanceOf(PiperTts);
});

it('routes previews and different actors through the saved voice and speed, never by a client payload', async () => {
  const calls: string[] = [];
  const store = new VoiceServiceStore(undefined, (config) => ({
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
  const store = new VoiceServiceStore(undefined, () => ({
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
  const store = new VoiceServiceStore(undefined, factory);
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
  const restored = new VoiceServiceStore(store.persistence);
  await restored.load();
  expect(restored.get(saved.id).voiceLanguage).toBe('zh-CN');
});
