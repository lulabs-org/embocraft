export type BailianAsrSettings = {
  region: 'beijing' | 'singapore';
  workspaceId: string;
  model: 'fun-asr-realtime' | 'paraformer-realtime-v2';
};
export type BailianAsrDraft = BailianAsrSettings & { apiKey: string };
export type BailianAsrView = BailianAsrSettings & { hasApiKey: boolean };
export type WhisperAsrSettings = {
  baseUrl?: string;
  model: string;
  temperature: number;
  prompt: string;
};
export type WhisperAsrDraft = WhisperAsrSettings & { apiKey?: string };
export type WhisperAsrView = WhisperAsrSettings & { hasApiKey?: boolean };
export const DEFAULT_WHISPER_ASR: WhisperAsrSettings = {
  model: 'Systran/faster-whisper-base',
  temperature: 0,
  prompt: '',
};
/** Offline SenseVoice running inside the project server; no address, model download or API key. */
export type SenseVoiceLanguage = 'auto' | 'zh' | 'en';
export type SenseVoiceAsrSettings = {
  model: string;
  language: SenseVoiceLanguage;
};
export const DEFAULT_SENSE_VOICE_ASR: SenseVoiceAsrSettings = {
  model: 'default',
  language: 'zh',
};
export type AsrProviderDraft =
  | (BailianAsrDraft & { provider?: 'bailian'; name: string })
  | (WhisperAsrDraft & { provider: 'whisper'; name: string })
  | (SenseVoiceAsrSettings & { provider: 'sense-voice'; name: string });
export type AsrProviderView =
  | (BailianAsrView & { provider?: 'bailian'; id: string; name: string })
  | (WhisperAsrView & { provider: 'whisper'; id: string; name: string })
  | (SenseVoiceAsrSettings & {
      provider: 'sense-voice';
      id: string;
      name: string;
    });
export type AsrServiceDraft = AsrProviderDraft;
export type AsrServiceView = AsrProviderView;
export const DEFAULT_BAILIAN_ASR: BailianAsrSettings = {
  region: 'beijing',
  workspaceId: '',
  model: 'fun-asr-realtime',
};
export type AsrEvent =
  | { type: 'ready' | 'finished' }
  | { type: 'partial' | 'final'; text: string }
  | { type: 'error'; message: string };

/** Public routing metadata; provider credentials and model parameters stay private. */
export type AsrUse = 'chat' | 'spatial' | 'clip';
export type AsrAssignment = {
  id: string;
  name: string;
  provider: 'whisper' | 'bailian' | 'sense-voice';
};
export type AsrAssignments = Record<AsrUse, AsrAssignment | null>;
