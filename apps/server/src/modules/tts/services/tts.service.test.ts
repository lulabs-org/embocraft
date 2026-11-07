import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_PIPER_MODEL, PIPER_MODELS } from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import { domainEvents } from '../../../core/events/domain-events';
import {
  MemoryVoicePersistence,
  voicePersistence,
} from '../../../../test/helpers/memory-storage';
import { TtsService } from '../composition';
import { validateVoiceService } from '../domain/voice-service-validation';

const mocked = vi.hoisted(() => ({
  persistence: undefined as unknown as MemoryVoicePersistence,
}));

vi.mock('../persistence/database-voice-services', () => ({
  DatabaseVoiceServicePersistence: vi.fn(function () {
    return {
      load: () => mocked.persistence.load(),
      get: (id: string) => mocked.persistence.get(id),
      transaction: <T>(
        run: Parameters<MemoryVoicePersistence['transaction']>[0],
      ) => mocked.persistence.transaction(run) as Promise<T>,
    };
  }),
}));

const local = (name = 'Local', voice = '') => ({
  name,
  type: 'speaches',
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

beforeEach(() => {
  mocked.persistence = voicePersistence();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('loads legacy Piper profiles as Speaches without changing IDs, names or models', async () => {
  const service = new TtsService();
  mocked.persistence.value = JSON.parse(
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

  expect((await service.list())[0]).toMatchObject({
    id: 'existing-voice',
    name: 'My Piper voice',
    type: 'speaches',
    model: PIPER_MODELS[1].id,
    baseUrl: '',
  });
  await service.save(
    { ...(await service.list())[0], speed: 0.8 },
    'existing-voice',
  );
  const restored = new TtsService();

  expect(await restored.get('existing-voice')).toMatchObject({
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

it('persists the Speaches endpoint and uses it for both previews and synthesizers', async () => {
  vi.stubEnv('SPEECH_API_URL', 'http://default-speech:8000/v1');
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(wav()));
  vi.stubGlobal('fetch', request);
  const service = new TtsService();

  const selected = await service.save({
    ...local(),
    model: 'vendor/new-tts',
    voice: 'speaker:2',
    baseUrl: 'http://custom-speech:8000/v1///',
    apiKey: 'speaches-test-key',
  });
  expect(selected.baseUrl).toBe('http://custom-speech:8000/v1');
  expect(JSON.stringify(selected)).not.toContain('speaches-test-key');
  const restored = new TtsService();

  await restored.save({ ...selected, apiKey: '' }, selected.id);
  await restored.synthesize(
    selected.id,
    'Preview',
    new AbortController().signal,
  );
  const resolved = await restored.synthesizer(selected.id);
  if (resolved.kind !== 'server') throw new Error('expected server speech');
  await resolved.synthesizer.synthesize('Agent', new AbortController().signal);
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

it('persists multiple configurations privately, masks credentials, and preserves a blank key on edit', async () => {
  const service = new TtsService();

  const cloud = await service.save(remote);
  const localVoice = await service.save(local('中文', 'Tingting'));
  expect(JSON.stringify(await service.list())).not.toContain(remote.apiKey);
  expect(cloud.hasApiKey).toBe(true);
  const changed: string[] = [];
  const off = domainEvents.on('tts.service.changed', ({ serviceId }) =>
    changed.push(serviceId),
  );
  try {
    await service.save({ ...cloud, apiKey: '', name: 'Renamed' }, cloud.id);
  } finally {
    off();
  }
  expect(changed).toEqual([cloud.id]);
  expect((await service.get(cloud.id)).apiKey).toBe(remote.apiKey);
  const restored = new TtsService();

  expect(await restored.list()).toHaveLength(3);
  expect((await restored.get(localVoice.id)).model).toBe(DEFAULT_PIPER_MODEL);
  expect(await mocked.persistence.load()).toHaveLength(3);
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

it('guards deletion via tts.service.removing event and emits tts.service.changed on removal', async () => {
  const service = new TtsService();
  let referenced = true;
  const changed: string[] = [];
  const offGuard = domainEvents.on('tts.service.removing', ({ serviceId }) => {
    if (referenced && serviceId === 'local-default')
      throw new AppError('语音服务仍被引用，无法删除。', 409);
  });
  const offChanged = domainEvents.on('tts.service.changed', ({ serviceId }) =>
    changed.push(serviceId),
  );
  try {
    await expect(service.remove('local-default')).rejects.toThrow('引用');
    expect(changed).toEqual([]);
    referenced = false;
    await service.remove('local-default');
    expect(changed).toEqual(['local-default']);
    expect(await service.list()).toEqual([]);
  } finally {
    offGuard();
    offChanged();
  }
});

it('routes previews and synthesizers through the saved voice and speed', async () => {
  const calls: string[] = [];
  const service = new TtsService(undefined, (config) => ({
    synthesize: async (text) => {
      calls.push(`${config.model}:${config.speed}:${text}`);
      return { bytes: wav(), durationMs: 1000 };
    },
  }));

  const a = await service.save({ ...local('A', 'Tingting'), speed: 0.8 });
  const b = await service.save(local('B', 'Samantha'));
  await service.synthesize(a.id, 'Preview', new AbortController().signal);
  const voiceA = await service.synthesizer(a.id);
  const voiceB = await service.synthesizer(b.id);
  if (voiceA.kind !== 'server' || voiceB.kind !== 'server')
    throw new Error('expected server speech');
  await voiceA.synthesizer.synthesize('Agent A', new AbortController().signal);
  await voiceB.synthesizer.synthesize('Agent B', new AbortController().signal);
  expect(calls).toEqual([
    `${DEFAULT_PIPER_MODEL}:0.8:Preview`,
    `${DEFAULT_PIPER_MODEL}:0.8:Agent A`,
    `${PIPER_MODELS[1].id}:1:Agent B`,
  ]);
});

it('cancels previews and bounds concurrent synthesis', async () => {
  const pending: (() => void)[] = [];
  const service = new TtsService(undefined, () => ({
    synthesize: async () => {
      await new Promise<void>((resolve) => pending.push(resolve));
      return { bytes: wav(), durationMs: 1000 };
    },
  }));

  const abort = new AbortController();
  const first = service.synthesize('local-default', 'one', abort.signal);
  const second = service.synthesize(
    'local-default',
    'two',
    new AbortController().signal,
  );
  await expect(
    service.synthesize('local-default', 'three', new AbortController().signal),
  ).rejects.toThrow('繁忙');
  abort.abort();
  pending.forEach((resolve) => resolve());
  await expect(first).rejects.toThrow();
  await second;
});

it('keeps the unmanaged default voice independent of saved-service concurrency', async () => {
  const pending: (() => void)[] = [];
  const service = new TtsService(undefined, () => ({
    synthesize: async () => {
      await new Promise<void>((resolve) => pending.push(resolve));
      return { bytes: wav(), durationMs: 1000 };
    },
  }));
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(wav()));
  vi.stubGlobal('fetch', fetch);
  vi.stubEnv('SPEECH_API_URL', 'http://default-speech:8000/v1');
  const signal = new AbortController().signal;
  const first = service.synthesize('local-default', 'one', signal);
  const second = service.synthesize('local-default', 'two', signal);
  try {
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    await expect(
      service.synthesize('local-default', 'three', signal),
    ).rejects.toMatchObject({
      status: 429,
    });
    const resolved = await service.resolveSpeech(undefined);
    if (resolved.kind !== 'server') throw new Error('expected server speech');
    await expect(
      resolved.synthesizer.synthesize('default', signal),
    ).resolves.toMatchObject({ durationMs: 1000 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(
      'http://default-speech:8000/v1/audio/speech',
    );
  } finally {
    pending.forEach((resolve) => resolve());
    await Promise.all([first, second]);
  }
});

it('persists browser profiles without credentials and never runs server synthesis', async () => {
  const factory = vi.fn();
  const service = new TtsService(undefined, factory);

  const saved = await service.save({
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
  expect(await service.synthesizer(saved.id)).toEqual({
    kind: 'browser',
    voice: { voice: saved.voice, speed: 1, voiceLanguage: 'zh-CN' },
  });
  await expect(
    service.synthesize(saved.id, '你好', new AbortController().signal),
  ).rejects.toThrow('浏览器');
  expect(factory).not.toHaveBeenCalled();
  const restored = new TtsService();

  expect((await restored.get(saved.id)).voiceLanguage).toBe('zh-CN');
});

it('resolves unbound, empty and saved bindings through their existing paths', async () => {
  const defaultSpeech = { synthesize: vi.fn() };
  const service = new TtsService(undefined, undefined, () => defaultSpeech);
  const browser = await service.save({
    name: 'Browser',
    type: 'browser',
    voice: 'test',
  });

  expect(await service.resolveSpeech(undefined)).toEqual({
    kind: 'server',
    synthesizer: defaultSpeech,
  });
  expect(await service.resolveSpeech(browser.id)).toMatchObject({
    kind: 'browser',
    voice: { voice: 'test' },
  });
  const empty = await service.resolveSpeech('');
  if (empty.kind !== 'server') throw new Error('expected server speech');
  const signal = new AbortController().signal;
  await expect(
    empty.synthesizer.synthesize('text', signal),
  ).rejects.toMatchObject({ status: 404 });
  expect(defaultSpeech.synthesize).not.toHaveBeenCalled();
});

it('keeps committed updates and removals successful when a change listener fails', async () => {
  const service = new TtsService();
  const saved = await service.save({ ...local(), name: 'Before' });
  const later = vi.fn();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const releaseFailure = domainEvents.on('tts.service.changed', () => {
    throw new Error('private details');
  });
  const releaseLater = domainEvents.on('tts.service.changed', later);
  try {
    await expect(
      service.save({ ...saved, name: 'After' }, saved.id),
    ).resolves.toMatchObject({ name: 'After' });
    expect((await service.get(saved.id)).name).toBe('After');
    await expect(service.remove(saved.id)).resolves.toBeUndefined();
    await expect(service.get(saved.id)).rejects.toMatchObject({ status: 404 });
    expect(later).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private details');
  } finally {
    releaseFailure();
    releaseLater();
    log.mockRestore();
  }
});

it('does not notify about a failed transaction and releases deletion coordination for retry', async () => {
  const service = new TtsService();
  const saved = await service.save({ ...local(), name: 'Voice' });
  const changed = vi.fn();
  const release = domainEvents.on('tts.service.changed', changed);
  try {
    mocked.persistence.saveError = new Error('storage failure');
    await expect(service.remove(saved.id)).rejects.toThrow('storage failure');
    expect(changed).not.toHaveBeenCalled();
    expect(await service.get(saved.id)).toMatchObject({ id: saved.id });
    mocked.persistence.saveError = undefined;
    await service.remove(saved.id);
    expect(changed).toHaveBeenCalledExactlyOnceWith({ serviceId: saved.id });
  } finally {
    mocked.persistence.saveError = undefined;
    release();
  }
});

it('reports an unexpected notifier failure without misreporting a committed update', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const coordination = {
    withRemoval: async <T>(_id: string, operation: () => Promise<T>) =>
      operation(),
    assertRemovable: () => {},
    notifyChanged: () => {
      throw new Error('private details');
    },
  };
  const service = new TtsService(
    undefined,
    undefined,
    undefined,
    undefined,
    coordination,
  );
  try {
    const saved = await service.save({ ...local(), name: 'Before' });
    await expect(
      service.save({ ...saved, name: 'After' }, saved.id),
    ).resolves.toMatchObject({ name: 'After' });
    expect((await service.get(saved.id)).name).toBe('After');
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain('private details');
  } finally {
    log.mockRestore();
  }
});
