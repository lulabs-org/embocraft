export type BailianAsrSettings = {
  region: 'beijing' | 'singapore';
  workspaceId: string;
  model: 'fun-asr-realtime' | 'paraformer-realtime-v2';
};
export type BailianAsrDraft = BailianAsrSettings & { apiKey: string };
export type BailianAsrView = BailianAsrSettings & { hasApiKey: boolean };
/** Remote endpoint speaking the OpenAI `/audio/transcriptions` contract. */
export type OpenAiAsrSettings = {
  baseUrl: string;
  model: string;
};
export type OpenAiAsrDraft = OpenAiAsrSettings & { apiKey: string };
export type OpenAiAsrView = OpenAiAsrSettings & { hasApiKey: boolean };
export type WhisperAsrSettings = {
  model: string;
  threads: number;
  beamSize: number;
  temperature: number;
  prompt: string;
};
export const DEFAULT_WHISPER_ASR: WhisperAsrSettings = {
  model: 'default',
  threads: 4,
  beamSize: 5,
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
export type AsrServiceDraft =
  | (BailianAsrDraft & { provider?: 'bailian'; name: string })
  | (WhisperAsrSettings & { provider: 'whisper'; name: string })
  | (SenseVoiceAsrSettings & { provider: 'sense-voice'; name: string })
  | (OpenAiAsrDraft & { provider: 'openai'; name: string });
export type AsrServiceView =
  | (BailianAsrView & { provider?: 'bailian'; id: string; name: string })
  | (WhisperAsrSettings & { provider: 'whisper'; id: string; name: string })
  | (SenseVoiceAsrSettings & {
      provider: 'sense-voice';
      id: string;
      name: string;
    })
  | (OpenAiAsrView & { provider: 'openai'; id: string; name: string });
export const DEFAULT_BAILIAN_ASR: BailianAsrSettings = {
  region: 'beijing',
  workspaceId: '',
  model: 'fun-asr-realtime',
};
/** Self-hosted or vendor gateways that accept OpenAI multipart transcriptions. */
export const DEFAULT_OPENAI_ASR: OpenAiAsrDraft = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'whisper-1',
  apiKey: '',
};
export type AsrEvent =
  | { type: 'ready' | 'finished' }
  | { type: 'partial' | 'final'; text: string }
  | { type: 'error'; message: string };
