import type { SenseVoiceAsrSettings, WhisperAsrDraft } from '@voxel/shared';

/** Engines the project server can run itself; Bailian streams over its own WebSocket. */
export type SpeechSettings = WhisperAsrDraft | SenseVoiceAsrSettings;
export type SpeechStatus = { available: boolean; reason: string };

/** Everything the HTTP and chat voice routes need from a speech-to-text engine. */
export type SpeechTranscriber = {
  status(settings?: SpeechSettings): Promise<SpeechStatus>;
  normalize(
    audio: Buffer,
    contentType: string,
    signal: AbortSignal,
  ): Promise<{ bytes: Buffer; durationMs: number }>;
  transcribe(
    audio: Buffer,
    contentType: string,
    language: string,
    signal: AbortSignal,
    settings?: SpeechSettings,
  ): Promise<string>;
};
