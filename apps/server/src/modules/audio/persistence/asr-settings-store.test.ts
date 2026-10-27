import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AsrSettingsStore,
  asrEndpoint,
  validateAsrSettings,
} from './asr-settings-store';
import { DEFAULT_BAILIAN_ASR, DEFAULT_WHISPER_ASR } from '@voxel/shared';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const draft = {
  ...DEFAULT_BAILIAN_ASR,
  name: '模型 A',
  apiKey: 'secret-for-test',
};
it('persists a private key server-side, masks it, reloads, and preserves blank keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asr-test-'));
  dirs.push(dir);
  const store = new AsrSettingsStore(join(dir, 'asr.json'));
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
  const restored = new AsrSettingsStore(store.path);
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
  const afterDelete = new AsrSettingsStore(store.path);
  await afterDelete.load();
  expect(afterDelete.list()).toEqual([b]);
  expect(() => afterDelete.get(a.id)).toThrow('不存在');
  expect((await stat(store.path)).mode & 0o777).toBe(0o600);
});
it('migrates the singleton once while retaining secret, settings and a stable service ID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asr-migration-'));
  dirs.push(dir);
  const path = join(dir, 'asr.json');
  const legacy = {
    ...DEFAULT_BAILIAN_ASR,
    region: 'singapore',
    workspaceId: 'my-space',
    apiKey: 'legacy-key',
  };
  await writeFile(path, JSON.stringify(legacy));
  const store = new AsrSettingsStore(path);
  await store.load();
  const [service] = store.list();
  expect(service.name).toBe('阿里云百炼');
  expect(store.get(service.id)).toMatchObject(legacy);
  expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(3);
  const reloaded = new AsrSettingsStore(path);
  await reloaded.load();
  expect(reloaded.list()).toEqual(store.list());
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});
it('protects active services and never inherits another service secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asr-active-'));
  dirs.push(dir);
  const store = new AsrSettingsStore(join(dir, 'asr.json'));
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
  const dir = await mkdtemp(join(tmpdir(), 'asr-limit-'));
  dirs.push(dir);
  const store = new AsrSettingsStore(join(dir, 'asr.json'));
  await store.load();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.save({ ...draft, name: `服务 ${i}` }),
    ),
  );
  expect(new Set(store.list().map((v) => v.id)).size).toBe(20);
  await expect(store.save(draft)).rejects.toThrow('20');
  const reloaded = new AsrSettingsStore(store.path);
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

it('persists multiple Whisper parameter profiles alongside legacy cloud profiles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whisper-profiles-'));
  dirs.push(dir);
  const store = new AsrSettingsStore(join(dir, 'asr.json'));
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
    threads: 8,
    beamSize: 8,
    temperature: 0.3,
    prompt: '术语',
  });
  await store.save(draft);
  await store.save({ ...base, threads: 2 }, a.id);
  const restored = new AsrSettingsStore(store.path);
  await restored.load();
  expect(restored.get(a.id)).toMatchObject({ provider: 'whisper', threads: 2 });
  expect(restored.get(b.id)).toMatchObject({
    threads: 8,
    beamSize: 8,
    temperature: 0.3,
    prompt: '术语',
  });
  expect(restored.list()).toHaveLength(3);
  expect(restored.list()[0]).not.toHaveProperty('apiKey');
  await expect(store.save(draft, a.id)).rejects.toThrow('类型');
  for (const patch of [
    { threads: 0 },
    { threads: 1.5 },
    { beamSize: 9 },
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

it('converts the old fixed Whisper entry once and never recreates it after deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asr-fixed-migration-'));
  dirs.push(dir);
  const path = join(dir, 'asr.json');
  const original = { ...draft, id: 'cloud-existing', provider: 'bailian' };
  await writeFile(path, JSON.stringify({ version: 2, services: [original] }));
  const store = new AsrSettingsStore(path);
  await store.load();
  expect(store.get(original.id)).toEqual(original);
  const whisper = store.list().find((v) => v.provider === 'whisper')!;
  expect(whisper).toMatchObject({
    ...DEFAULT_WHISPER_ASR,
    name: '自托管 Whisper',
  });
  await store.save(
    { ...whisper, name: '我的 Whisper', threads: 2 },
    whisper.id,
  );
  const reloaded = new AsrSettingsStore(path);
  await reloaded.load();
  expect(reloaded.list()).toHaveLength(2);
  expect(reloaded.get(whisper.id)).toMatchObject({
    name: '我的 Whisper',
    threads: 2,
  });
  await reloaded.remove(whisper.id);
  await reloaded.remove(original.id);
  const empty = new AsrSettingsStore(path);
  await empty.load();
  expect(empty.list()).toEqual([]);
  expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(3);
});

it('upgrades a full legacy list without losing existing profiles or exceeding its limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asr-full-migration-'));
  dirs.push(dir);
  const path = join(dir, 'asr.json');
  const services = Array.from({ length: 20 }, (_, i) => ({
    ...draft,
    id: `old-${i}`,
    provider: 'bailian',
  }));
  await writeFile(path, JSON.stringify({ version: 2, services }));
  const store = new AsrSettingsStore(path);
  await store.load();
  expect(store.list()).toHaveLength(20);
  expect(store.get('old-19')).toEqual(services[19]);
  expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(3);
});
