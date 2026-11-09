import type { AsrServiceDraft, AsrServiceView } from '@voxel/shared';
import { browserLanguages } from './browser-asr-languages';

export type BrowserAsrDraft = {
  provider: 'browser';
  name: string;
  language: string;
};
export type BrowserAsrService = BrowserAsrDraft & { id: string };
export type WebAsrDraft = AsrServiceDraft | BrowserAsrDraft;
export type WebAsrService = AsrServiceView | BrowserAsrService;
export type AsrProvider = 'bailian' | 'whisper' | 'sense-voice' | 'browser';
export const BROWSER_ASR_STORAGE_KEY = 'voxel.browser-asr-services.v1';

function validate(draft: BrowserAsrDraft): BrowserAsrDraft {
  if (
    typeof draft.name !== 'string' ||
    !draft.name.trim() ||
    draft.name.trim().length > 50
  )
    throw new Error('请填写 1–50 字的服务名称。');
  if (!browserLanguages.some(([code]) => code === draft.language))
    throw new Error('请选择有效的主要识别语言。');
  return {
    provider: 'browser',
    name: draft.name.trim(),
    language: draft.language,
  };
}

// Browser profiles never enter the server ASR contract or send audio/configuration to it.
export function readBrowserAsrServices(
  storage: Pick<Storage, 'getItem'>,
): BrowserAsrService[] {
  const raw = storage.getItem(BROWSER_ASR_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const values: unknown = Array.isArray(parsed)
      ? parsed
      : parsed?.version === 2
        ? parsed.services
        : undefined;
    if (!Array.isArray(values) || values.length > 20) throw new Error();
    const ids = new Set<string>();
    return values.map((value) => {
      if (
        !value ||
        value.provider !== 'browser' ||
        typeof value.id !== 'string' ||
        !/^browser-asr-[a-zA-Z0-9-]+$/.test(value.id) ||
        ids.has(value.id)
      )
        throw new Error();
      ids.add(value.id);
      return { ...validate(value), id: value.id };
    });
  } catch {
    throw new Error('当前浏览器保存的识别配置无法读取；未覆盖原有数据。');
  }
}
export function saveBrowserAsrService(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  draft: BrowserAsrDraft,
  id?: string,
) {
  const values = readBrowserAsrServices(storage);
  if (id && !values.some((value) => value.id === id))
    throw new Error('浏览器识别服务已不存在，请刷新列表。');
  if (!id && values.length >= 20)
    throw new Error('最多保存 20 份浏览器识别配置。');
  const saved = {
    ...validate(draft),
    id: id ?? `browser-asr-${crypto.randomUUID()}`,
  };
  const services = id
    ? values.map((value) => (value.id === id ? saved : value))
    : [...values, saved];
  storage.setItem(
    BROWSER_ASR_STORAGE_KEY,
    JSON.stringify({ version: 2, services }),
  );
  return { saved, services };
}
export function deleteBrowserAsrService(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  id: string,
) {
  const services = readBrowserAsrServices(storage).filter(
    (value) => value.id !== id,
  );
  storage.setItem(
    BROWSER_ASR_STORAGE_KEY,
    JSON.stringify({ version: 2, services }),
  );
  return services;
}

/** Convert the formerly fixed entry once for existing installations, never on refresh. */
export function migrateBrowserAsrServices(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
) {
  const services = readBrowserAsrServices(storage);
  const raw = storage.getItem(BROWSER_ASR_STORAGE_KEY);
  if (raw && Array.isArray(JSON.parse(raw))) {
    if (services.length < 20)
      services.push({
        id: `browser-asr-${crypto.randomUUID()}`,
        provider: 'browser',
        name: '浏览器语音识别（Web Speech API）',
        language: 'zh-CN',
      });
    storage.setItem(
      BROWSER_ASR_STORAGE_KEY,
      JSON.stringify({ version: 2, services }),
    );
  }
  return services;
}
