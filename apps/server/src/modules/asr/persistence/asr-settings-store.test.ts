import { DEFAULT_BAILIAN_ASR, DEFAULT_WHISPER_ASR } from '@voxel/shared';
import { expect, it } from 'vitest';
import { TestAsrSettingsStore as AsrSettingsStore } from '../../../../test/helpers/memory-storage';
import { asrEndpoint, validateAsrSettings } from './asr-settings-store';
const draft = {
  ...DEFAULT_BAILIAN_ASR,
  name: '模型 A',
  apiKey: 'secret-for-test',
};
it('persists private Speaches connections and preserves assignments without leaking or moving keys', async () => {
  const store = new AsrSettingsStore();
  await store.load();
  const config = {
    ...DEFAULT_WHISPER_ASR,
    provider: 'whisper',
    name: 'Speaches',
    baseUrl: 'http://selected:8000/v1/',
    apiKey: 'private-speaches-key',
    model: 'vendor/custom-asr',
  };
  const saved = await store.save(config);
  expect(saved).toMatchObject({
    baseUrl: 'http://selected:8000/v1',
    hasApiKey: true,
  });
  expect(saved).not.toHaveProperty('apiKey');
  await store.assign('spatial', saved.id);
  await store.save({ ...config, apiKey: '' }, saved.id);
  const restored = new AsrSettingsStore(store.persistence);
  await restored.load();
  expect(restored.get(saved.id)).toMatchObject({
    apiKey: config.apiKey,
    model: config.model,
  });
  expect(restored.assignments().spatial?.id).toBe(saved.id);
  expect(JSON.stringify(restored.list())).not.toContain(config.apiKey);
  await expect(
    restored.save(
      { ...config, apiKey: '', baseUrl: 'http://other:8000/v1' },
      saved.id,
    ),
  ).rejects.toThrow('重新填写');
  await expect(
    restored.save({ ...config, baseUrl: 'file:///tmp/speech' }),
  ).rejects.toThrow();
});
it('persists a private key server-side, masks it, reloads, and preserves blank keys', async () => {
  const store = new AsrSettingsStore();
  await store.load();
  expect(store.list()).toEqual([]);
  expect(() => store.get('missing')).toThrow('不存在');
  const a = await store.save(draft);
  const b = await store.save({
    ...draft,
    name: '模型 B',
    model: 'paraformer-realtime-v2',
    apiKey: 'second-key',
  });
  expect(JSON.stringify(store.list())).not.toContain(draft.apiKey);
  expect(JSON.stringify(store.list())).not.toContain('second-key');
  await store.save({ ...draft, apiKey: '', name: '模型 A 改名' }, a.id);
  const restored = new AsrSettingsStore(store.persistence);
  await restored.load();
  expect(restored.get(a.id)).toMatchObject({
    apiKey: draft.apiKey,
    model: 'fun-asr-realtime',
    name: '模型 A 改名',
  });
  expect(restored.get(b.id)).toMatchObject({
    apiKey: 'second-key',
    model: 'paraformer-realtime-v2',
    name: '模型 B',
  });
  await restored.remove(a.id);
  const afterDelete = new AsrSettingsStore(store.persistence);
  await afterDelete.load();
  expect(afterDelete.list()).toEqual([b]);
  expect(() => afterDelete.get(a.id)).toThrow('不存在');
});
it('protects active services and never inherits another service secret', async () => {
  const store = new AsrSettingsStore();
  await store.load();
  const a = await store.save(draft);
  await expect(
    store.save({ ...draft, name: 'empty key', apiKey: '' }),
  ).rejects.toThrow('API Key');
  await expect(store.save({ ...draft, name: ' ' }, a.id)).rejects.toThrow(
    '名称',
  );
  const use = store.acquire(a.id);
  await expect(store.remove(a.id)).rejects.toThrow('正在识别');
  await store.save({ ...draft, model: 'paraformer-realtime-v2' }, a.id);
  expect(use.settings.model).toBe('fun-asr-realtime');
  use.release();
  use.release();
  await store.remove(a.id);
  expect(store.list()).toEqual([]);
});
it('serializes concurrent creates and enforces the service limit', async () => {
  const store = new AsrSettingsStore();
  await store.load();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.save({ ...draft, name: `服务 ${i}` }),
    ),
  );
  expect(new Set(store.list().map((v) => v.id)).size).toBe(20);
  await expect(store.save(draft)).rejects.toThrow('20');
  const reloaded = new AsrSettingsStore(store.persistence);
  await reloaded.load();
  expect(reloaded.list()).toEqual(store.list());
});
it('restricts endpoints, models, and cross-region credential reuse', () => {
  expect(
    asrEndpoint({ ...draft, region: 'singapore', workspaceId: 'workspace123' }),
  ).toBe(
    'wss://workspace123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference',
  );
  expect(() =>
    validateAsrSettings({ ...draft, apiKey: '', region: 'singapore' }, draft),
  ).toThrow('重新填写');
  expect(() =>
    validateAsrSettings({ ...draft, apiKey: '', workspaceId: 'other' }, draft),
  ).toThrow('重新填写');
  expect(() =>
    validateAsrSettings({ ...draft, workspaceId: 'example.com/path' }),
  ).toThrow('ID');
  expect(() =>
    validateAsrSettings({ ...draft, apiKey: 'key\nheader' }),
  ).toThrow('格式');
  expect(() => validateAsrSettings({ ...draft, model: 'qwen-tts' })).toThrow(
    '模型',
  );
});

it('persists multiple Whisper parameter profiles alongside cloud profiles', async () => {
  const store = new AsrSettingsStore();
  await store.load();
  const base = {
    ...DEFAULT_WHISPER_ASR,
    provider: 'whisper',
    name: 'Whisper A',
  };
  const a = await store.save(base);
  const b = await store.save({
    ...base,
    name: 'Whisper B',
    model: 'Systran/faster-whisper-large-v3',
    temperature: 0.3,
    prompt: '术语',
  });
  await store.save(draft);
  await store.save({ ...base, model: 'Systran/faster-whisper-small' }, a.id);
  const restored = new AsrSettingsStore(store.persistence);
  await restored.load();
  expect(restored.get(a.id)).toMatchObject({
    provider: 'whisper',
    model: 'Systran/faster-whisper-small',
  });
  expect(restored.get(b.id)).toMatchObject({
    model: 'Systran/faster-whisper-large-v3',
    temperature: 0.3,
    prompt: '术语',
  });
  expect(restored.list()).toHaveLength(3);
  expect(restored.list()[0]).not.toHaveProperty('apiKey');
  await expect(store.save(draft, a.id)).rejects.toThrow('类型');
  for (const patch of [
    { model: '' },
    { model: 'bad model' },
    { model: 'a'.repeat(201) },
    { temperature: NaN },
    { temperature: 1.1 },
    { model: '../../secret.bin' },
    { prompt: 'a'.repeat(501) },
  ]) {
    await expect(store.save({ ...base, ...patch })).rejects.toThrow();
  }
  await restored.remove(a.id);
  expect(restored.get(b.id).name).toBe('Whisper B');
});

it('drops unused local engine fields and normalizes an existing default model without losing profiles', async () => {
  const store = new AsrSettingsStore();
  await store.load();
  const saved = await store.save({
    ...DEFAULT_WHISPER_ASR,
    model: 'default',
    provider: 'whisper',
    name: 'Existing',
    threads: 8,
    beamSize: 7,
  });
  const restored = new AsrSettingsStore(store.persistence);
  await restored.load();
  expect(restored.get(saved.id)).toMatchObject({
    id: saved.id,
    name: 'Existing',
    model: DEFAULT_WHISPER_ASR.model,
  });
  expect(restored.get(saved.id)).not.toHaveProperty('threads');
  expect(restored.get(saved.id)).not.toHaveProperty('beamSize');
});

it('persists independent global assignments across edits and restart, without exposing credentials', async () => {
  const store = new AsrSettingsStore();
  const whisper = await store.save({
    ...DEFAULT_WHISPER_ASR,
    provider: 'whisper',
    name: '任意名称',
  });
  const ali = await store.save(draft);
  expect(store.assignments().clip?.id).toBe(whisper.id);
  await Promise.all([
    store.assign('chat', ali.id),
    store.assign('spatial', ali.id),
  ]);
  await store.save({ ...draft, name: '改名', apiKey: '' }, ali.id);
  const restored = new AsrSettingsStore(store.persistence);
  await restored.load();
  expect(restored.assignments()).toEqual({
    chat: { id: ali.id, name: '改名', provider: 'bailian' },
    spatial: { id: ali.id, name: '改名', provider: 'bailian' },
    clip: { id: whisper.id, name: '任意名称', provider: 'whisper' },
  });
  expect(JSON.stringify(restored.assignments())).not.toContain('apiKey');
  await restored.remove(ali.id);
  expect(restored.assignments().chat?.id).toBe(whisper.id);
  await restored.remove(whisper.id);
  expect(restored.assignments()).toEqual({
    chat: null,
    spatial: null,
    clip: null,
  });
});

it('rejects invalid assignments and does not publish failed writes or client-injected uses', async () => {
  const store = new AsrSettingsStore();
  const whisper = await store.save({
    ...DEFAULT_WHISPER_ASR,
    provider: 'whisper',
    name: 'Whisper',
  });
  const ali = await store.save({ ...draft, uses: ['chat'] });
  expect(store.assignments().chat?.id).toBe(whisper.id);
  await expect(store.assign('clip', ali.id)).rejects.toThrow('Whisper');
  await expect(store.assign('other', whisper.id)).rejects.toThrow('无效');
  await expect(store.assign('chat', 'missing')).rejects.toThrow('不存在');
  store.persistence.saveError = new Error('disk');
  await expect(store.assign('chat', ali.id)).rejects.toThrow('disk');
  expect(store.assignments().chat?.id).toBe(whisper.id);
});
