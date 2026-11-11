export { createTtsRouter } from './routes/tts.routes';
export { DatabaseVoiceServicePersistence } from './persistence/database-voice-services';
export {
  createDefaultSpeechStatus,
  createTtsService,
  ttsService,
} from './composition';
export { TtsService } from './services/tts.service';
export { validateVoiceService } from './domain/voice-service-validation';
export { PiperModels } from './services/piper-models.service';
export {
  createDefaultSpeechSynthesizer,
  SpeachesTtsAdapter,
} from './adapters/speaches-tts.adapter';
export type {
  ResolvedSpeech,
  SpeechSynthesizer,
} from './services/speech-synthesizer';
