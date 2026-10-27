export type SynthesizedSpeech = { bytes: Buffer; durationMs: number };
export interface SpeechSynthesizer {
  browserVoice?: { voice: string; speed: number; voiceLanguage?: string };
  synthesize(text: string, signal: AbortSignal): Promise<SynthesizedSpeech>;
}
