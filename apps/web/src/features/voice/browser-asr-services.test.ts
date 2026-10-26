import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_ASR_STORAGE_KEY,
  migrateBrowserAsrServices,
  readBrowserAsrServices,
  saveBrowserAsrService,
  deleteBrowserAsrService,
} from './browser-asr-services';
const storage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};
const draft = {
  provider: 'browser' as const,
  name: '中文识别',
  language: 'zh-CN',
};
describe('browser-only ASR profiles', () => {
  it('persists independent named language profiles, edits by ID, and removes only the selected profile', () => {
    const store = storage();
    const a = saveBrowserAsrService(store, draft).saved;
    const b = saveBrowserAsrService(store, {
      ...draft,
      name: '日语识别',
      language: 'ja-JP',
    }).saved;
    expect(a.id).not.toBe(b.id);
    expect(readBrowserAsrServices(store)).toEqual([a, b]);
    const updated = saveBrowserAsrService(
      store,
      { ...draft, name: '粤语识别', language: 'zh-HK' },
      a.id,
    ).saved;
    expect(updated.id).toBe(a.id);
    expect(readBrowserAsrServices(store)).toEqual([updated, b]);
    deleteBrowserAsrService(store, a.id);
    expect(readBrowserAsrServices(store)).toEqual([b]);
  });
  it('validates drafts before writing and excludes unrelated fields such as credentials', () => {
    const store = storage();
    expect(() =>
      saveBrowserAsrService(store, { ...draft, name: '  ' }),
    ).toThrow('名称');
    expect(() =>
      saveBrowserAsrService(store, { ...draft, language: 'invalid' }),
    ).toThrow('语言');
    expect(readBrowserAsrServices(store)).toEqual([]);
    saveBrowserAsrService(store, { ...draft, ...{ apiKey: 'must-not-store' } });
    expect(store.getItem(BROWSER_ASR_STORAGE_KEY)).not.toContain('apiKey');
  });
  it('does not overwrite corrupted persisted data', () => {
    const store = storage();
    store.setItem(BROWSER_ASR_STORAGE_KEY, 'broken-json');
    expect(() => readBrowserAsrServices(store)).toThrow('未覆盖');
    expect(() => saveBrowserAsrService(store, draft)).toThrow('未覆盖');
    expect(store.getItem(BROWSER_ASR_STORAGE_KEY)).toBe('broken-json');
  });
  it('surfaces storage failures and keeps the previous saved configuration', () => {
    const store = storage();
    const saved = saveBrowserAsrService(store, draft).saved;
    const failed = {
      ...store,
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError');
      }),
    };
    expect(() =>
      saveBrowserAsrService(failed, { ...draft, language: 'ja-JP' }, saved.id),
    ).toThrow('QuotaExceededError');
    expect(() => deleteBrowserAsrService(failed, saved.id)).toThrow(
      'QuotaExceededError',
    );
    expect(readBrowserAsrServices(store)).toEqual([saved]);
  });
  it('reads the latest storage on each mutation, bounds creation, and rejects stale edits', () => {
    const store = storage();
    const a = saveBrowserAsrService(store, draft).saved;
    // Another tab's saved profile must survive this tab's subsequent edit.
    const b = saveBrowserAsrService(store, {
      ...draft,
      language: 'en-US',
    }).saved;
    saveBrowserAsrService(store, { ...draft, name: '修改名称' }, a.id);
    expect(readBrowserAsrServices(store)).toContainEqual(b);
    for (let i = 2; i < 20; i++) saveBrowserAsrService(store, draft);
    expect(() => saveBrowserAsrService(store, draft)).toThrow('20');
    saveBrowserAsrService(store, draft, a.id);
    deleteBrowserAsrService(store, a.id);
    expect(() => saveBrowserAsrService(store, draft, a.id)).toThrow('已不存在');
    expect(readBrowserAsrServices(store)).toHaveLength(19);
  });
});

it('migrates the fixed browser entry to an editable profile once and keeps deletions across reloads', () => {
  const store = storage();
  const original = { ...draft, id: 'browser-asr-old' };
  store.setItem(BROWSER_ASR_STORAGE_KEY, JSON.stringify([original]));
  const migrated = migrateBrowserAsrServices(store);
  expect(migrated).toHaveLength(2);
  expect(migrated[0]).toEqual(original);
  const converted = migrated[1];
  expect(converted.name).toBe('浏览器语音识别（Web Speech API）');
  saveBrowserAsrService(
    store,
    { ...converted, language: 'ja-JP', name: '日语' },
    converted.id,
  );
  expect(migrateBrowserAsrServices(store)[1]).toMatchObject({
    id: converted.id,
    language: 'ja-JP',
    name: '日语',
  });
  deleteBrowserAsrService(store, converted.id);
  deleteBrowserAsrService(store, original.id);
  expect(migrateBrowserAsrServices(store)).toEqual([]);
  expect(migrateBrowserAsrServices(storage())).toEqual([]);
});
