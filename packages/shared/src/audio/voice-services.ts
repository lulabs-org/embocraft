export type VoiceServiceType =
  | 'speaches'
  | 'browser'
  | 'bailian'
  | 'mimo'
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
/** Xiaomi MiMo speaks the chat-completions contract; preset voices use this model. */
export const MIMO_TTS_MODEL = 'mimo-v2.5-tts';
export const MIMO_TTS_VOICES = [
  { id: 'mimo_default', name: 'MiMo 默认' },
  { id: '冰糖', name: '中文女声 · 冰糖' },
  { id: '茉莉', name: '中文女声 · 茉莉' },
  { id: '苏打', name: '中文男声 · 苏打' },
  { id: '白桦', name: '中文男声 · 白桦' },
  { id: 'Mia', name: 'English · Mia' },
  { id: 'Chloe', name: 'English · Chloe' },
  { id: 'Milo', name: 'English · Milo' },
  { id: 'Dean', name: 'English · Dean' },
] as const;
export const DEFAULT_MIMO_TTS_VOICE = MIMO_TTS_VOICES[0].id;
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
