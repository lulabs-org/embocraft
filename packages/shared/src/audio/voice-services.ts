export type VoiceServiceType = 'piper' | 'browser' | 'bailian' | 'compatible';
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
export type VoiceServiceSettings = {
  name: string;
  type: VoiceServiceType;
  baseUrl: string;
  model: string;
  voice: string;
  speed: number;
  voiceLanguage?: string;
};
export type VoiceServiceView = VoiceServiceSettings & {
  id: string;
  capability: 'tts';
  hasApiKey: boolean;
};
export type VoiceServiceDraft = VoiceServiceSettings & { apiKey: string };
