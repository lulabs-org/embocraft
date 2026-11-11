import { SpeachesModels } from '../../core/audio/speaches-models';
import { createSpeechAdapter } from './adapters/speech-adapter-factory';
import { DatabaseVoiceServicePersistence } from './persistence/database-voice-services';
import type {
  SpeechAdapterFactory,
  SpeechModelQuery,
  VoiceServicePersistence,
} from './ports';
import { createDefaultSpeechSynthesizer } from './adapters/speaches-tts.adapter';
import { PiperModels } from './services/piper-models.service';
import type { SpeechSynthesizer } from './services/speech-synthesizer';
import { TtsService } from './services/tts.service';

const queryModels: SpeechModelQuery = (connection, signal) =>
  new SpeachesModels(connection).list(signal);

/** Assemble the TTS application service with the module's default dependencies. */
export function createTtsService(
  storage: VoiceServicePersistence = new DatabaseVoiceServicePersistence(),
  factory: SpeechAdapterFactory = createSpeechAdapter,
  defaultSpeech: () => SpeechSynthesizer = createDefaultSpeechSynthesizer,
  models: SpeechModelQuery = queryModels,
) {
  return new TtsService(storage, factory, defaultSpeech, models);
}

export const ttsService = createTtsService();

/** Bind the deployment's default readiness check when the route is installed. */
export function createDefaultSpeechStatus() {
  const models = new PiperModels();
  return () => models.status();
}
