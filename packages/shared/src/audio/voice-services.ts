export type VoiceServiceType =
  | 'speaches'
  | 'browser'
  | 'bailian'
  | 'compatible';
export type TtsProviderType = VoiceServiceType;
/** Legacy profile migration and unmanaged default voice; never a discovery catalog. */
export const PIPER_MODELS = [
  {
    id: 'speaches-ai/piper-zh_CN-huayan-medium',
    name: '中文 · Huayan',
    language: 'zh',
    voice: 'huayan',
  },
  {
    id: 'speaches-ai/piper-en_US-lessac-medium',
    name: 'English · Lessac',
    language: 'en',
    voice: 'lessac',
  },
  {
    id: 'rhasspy/piper-voices/zh_CN-chaowen-medium',
    name: '中文 · 超文 Chaowen',
    language: 'zh',
    voice: 'chaowen',
  },
] as const;
export const DEFAULT_PIPER_MODEL = PIPER_MODELS[0].id;
export type TtsProviderSettings = {
  name: string;
  type: VoiceServiceType;
  baseUrl: string;
  model: string;
  voice: string;
  speed: number;
  voiceLanguage?: string;
};
export type VoiceServiceSettings = TtsProviderSettings;

export type TtsProviderView = TtsProviderSettings & {
  id: string;
  capability: 'tts';
  hasApiKey: boolean;
};
export type VoiceServiceView = TtsProviderView;

export type TtsProviderDraft = TtsProviderSettings & { apiKey: string };
export type VoiceServiceDraft = TtsProviderDraft;

export type SpeachesConnectionDraft = {
  baseUrl: string;
  apiKey: string;
  serviceId?: string;
};
export type SpeachesVoice = { id: string; name: string; language?: string };
export type SpeachesModel = {
  id: string;
  languages: string[];
  voices: SpeachesVoice[];
};
