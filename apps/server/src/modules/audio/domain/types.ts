export type VoiceState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'error';
export type VoiceEvent = {
  provider: string;
  state: VoiceState;
  turn: number;
  subtitle: string;
  error?: string;
  speakText?: string;
};
export type VoiceInput =
  | { kind: 'text'; text: string }
  | { kind: 'audio'; pcm: Uint8Array; sampleRate: 16000 };
/** Server-only provider boundary. A future provider must implement audio transport and credentials here. */
export interface VoiceSession {
  push(input: VoiceInput): void;
  interrupt(): void;
  close(): void;
}
export interface VoiceProvider {
  readonly id: string;
  create(emit: (event: VoiceEvent) => void): VoiceSession;
}
