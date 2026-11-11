import type { AsrServiceDraft, AsrServiceView, AsrUse } from '@voxel/shared';

/** Supported usage scenarios for ASR service binding. */
export const ASR_USES: readonly AsrUse[] = ['chat', 'spatial', 'clip'] as const;

export const SUPPORTED_ASR_PROVIDERS = [
  'whisper',
  'bailian',
  'openai',
  'gemini',
  'sense-voice',
] as const;
export type SupportedAsrProvider = (typeof SUPPORTED_ASR_PROVIDERS)[number];

/** Persisted ASR service entity; includes its unique ID and optional usage assignments. */
export type SavedService = AsrServiceDraft & {
  id: string;
  uses?: AsrUse[];
};

/**
 * Strip plaintext API credentials from a saved ASR service configuration,
 * returning a public view indicating only whether an API key has been configured.
 */
export function toAsrServiceView({
  uses: _uses,
  ...value
}: SavedService): AsrServiceView {
  // 服务器内引擎本身不持有密钥，因此按保存时的配置原样返回。
  if (value.provider === 'sense-voice') return value;
  const { apiKey, ...settings } = value;
  return { ...settings, hasApiKey: !!apiKey };
}
