import { WhisperAdapter } from './whisper/whisper.adapter';
import { SenseVoiceAdapter } from './sense-voice/sense-voice.adapter';

export const localSpeech = new WhisperAdapter();
/** 每个进程只保留一个 ONNX 会话；适配器内部会串行解码。 */
export const senseVoiceSpeech = new SenseVoiceAdapter();

export * from './whisper/whisper.adapter';
export * from './whisper/whisper.models';
export * from './bailian/bailian.adapter';
export * from './bailian/bailian.endpoint';
export * from './sense-voice/sense-voice.adapter';
export * from './sense-voice/sense-voice.models';
