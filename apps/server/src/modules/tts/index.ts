export { createTtsRouter } from './routes/tts.routes';
export { DatabaseVoiceServicePersistence } from './persistence/database-voice-services';
export {
  TtsService,
  ttsService,
  validateVoiceService,
} from './services/tts.service';
export { PiperModels } from './services/piper-models.service';
export {
  createDefaultSpeechSynthesizer,
  PiperTts,
} from './services/piper.service';
export type {
  ResolvedSpeech,
  SpeechSynthesizer,
} from './services/speech-synthesizer';
