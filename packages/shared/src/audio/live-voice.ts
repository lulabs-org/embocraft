/** Configuration for a native speech-to-speech Agent service. */
export type LiveVoiceProvider = 'openai' | 'gemini';
export type LiveVoiceSettings = {
  name: string;
  provider: LiveVoiceProvider;
  model: string;
  voice: string;
};
export type LiveVoiceDraft = LiveVoiceSettings & { apiKey: string };
export type LiveVoiceView = LiveVoiceSettings & {
  id: string;
  hasApiKey: boolean;
};
export const LIVE_VOICE_DEFAULTS: Record<
  LiveVoiceProvider,
  Pick<LiveVoiceSettings, 'model' | 'voice'>
> = {
  openai: { model: 'gpt-live-1', voice: 'marin' },
  gemini: { model: 'gemini-3.8-live', voice: 'Kore' },
};
