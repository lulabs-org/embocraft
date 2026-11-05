import { WhisperAdapter } from './whisper/whisper.adapter';

export const localSpeech = new WhisperAdapter();

export * from './whisper/whisper.adapter';
export * from './whisper/whisper.models';
export * from './bailian/bailian.adapter';
export * from './bailian/bailian.endpoint';
