export type BailianAsrSettings = {
  region: 'beijing' | 'singapore';
  workspaceId: string;
  model: 'fun-asr-realtime' | 'paraformer-realtime-v2';
};
export type BailianAsrDraft = BailianAsrSettings & { apiKey: string };
export type BailianAsrView = BailianAsrSettings & { hasApiKey: boolean };
export type WhisperAsrSettings = {
  model: string;
  temperature: number;
  prompt: string;
};
export const DEFAULT_WHISPER_ASR: WhisperAsrSettings = {
  model: 'Systran/faster-whisper-base',
  temperature: 0,
  prompt: '',
};
export type AsrServiceDraft =
  | (BailianAsrDraft & { provider?: 'bailian'; name: string })
  | (WhisperAsrSettings & { provider: 'whisper'; name: string });
export type AsrServiceView =
  | (BailianAsrView & { provider?: 'bailian'; id: string; name: string })
  | (WhisperAsrSettings & { provider: 'whisper'; id: string; name: string });
export const DEFAULT_BAILIAN_ASR: BailianAsrSettings = {
  region: 'beijing',
  workspaceId: '',
  model: 'fun-asr-realtime',
};
export type AsrEvent =
  | { type: 'ready' | 'finished' }
  | { type: 'partial' | 'final'; text: string }
  | { type: 'error'; message: string };
