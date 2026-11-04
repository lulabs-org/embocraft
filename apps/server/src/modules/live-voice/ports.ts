/** Raw mono PCM16 input and output for one provider voice session. */
export type LiveVoiceEvents = {
  ready(): void;
  audio(pcm: Buffer, sampleRate: number): void;
  interrupted(): void;
  transcript(
    speaker: 'human' | 'agent',
    text: string,
    timing?: { startMs: number; endMs: number },
  ): void;
  transcriptEnd(): void;
  delegation(id: string, request?: string, offsetMs?: number): void;
  cancelDelegation(id: string): void;
  error(message: string): void;
  closed(): void;
};

export type LiveVoiceSession = {
  readonly inputSampleRate: 16000 | 24000;
  sendAudio(pcm: Buffer): void;
  updateContext(text: string): void;
  deliverDelegation(id: string, result: string): void;
  close(): void;
};

export type LiveVoiceOptions = {
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
  events: LiveVoiceEvents;
};
