import { WhisperAdapter } from './whisper/whisper.adapter';
import { SenseVoiceAdapter } from './sense-voice/sense-voice.adapter';

export const localSpeech = new WhisperAdapter();
/** SenseVoice 同样连接外部容器，适配器只保留请求级串行保护。 */
export const senseVoiceSpeech = new SenseVoiceAdapter();

export * from './whisper/whisper.adapter';
export * from './whisper/whisper.models';
export * from './bailian/bailian.adapter';
export * from './bailian/bailian.endpoint';
export * from './sense-voice/sense-voice.adapter';
