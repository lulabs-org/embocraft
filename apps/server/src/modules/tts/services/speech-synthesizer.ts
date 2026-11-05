export type SynthesizedSpeech = { bytes: Buffer; durationMs: number };

/** Server-side synthesis provided by a TTS adapter. */
export interface SpeechSynthesizer {
  synthesize(text: string, signal: AbortSignal): Promise<SynthesizedSpeech>;
}

/** Playback capability resolved for a single speech task. */
export type ResolvedSpeech =
  | {
      kind: 'browser';
      voice: { voice: string; speed: number; voiceLanguage?: string };
    }
  | { kind: 'server'; synthesizer: SpeechSynthesizer };
