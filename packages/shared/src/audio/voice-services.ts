export type VoiceServiceType =
  | 'speaches'
  | 'browser'
  | 'bailian'
  | 'mimo'
  | 'compatible';
/** Piper models available for the deployment's unmanaged default voice. */
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
/**
 * Official preset catalog for MIMO_TTS_MODEL. IDs are sent verbatim as
 * `audio.voice`; Chinese voices are identified by the Chinese name itself
 * (e.g. 冰糖), which is intentional, not a typo.
 */
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
/**
 * Voice-clone model: `audio.voice` carries an mp3/wav sample as a base64 data
 * URI instead of a preset ID, so each request re-sends the sample.
 */
export const MIMO_TTS_CLONE_MODEL = 'mimo-v2.5-tts-voiceclone';
/** Data URI prefixes MiMo accepts for clone samples. */
export const MIMO_CLONE_SAMPLE_PREFIXES = [
  'data:audio/mpeg;base64,',
  'data:audio/mp3;base64,',
  'data:audio/wav;base64,',
  'data:audio/x-wav;base64,',
] as const;
/** MiMo caps the base64 payload at 10 MB; data URI prefix is negligible. */
export const MIMO_CLONE_SAMPLE_MAX_CHARS = 10 * 1024 * 1024;
/** Samples travel as data URIs; preset voices never match these prefixes. */
export function isMimoVoiceSample(voice: string): boolean {
  return MIMO_CLONE_SAMPLE_PREFIXES.some((prefix) => voice.startsWith(prefix));
}
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
