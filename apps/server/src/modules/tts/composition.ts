import { SpeachesModels } from '../../core/audio/speaches-models';
import { createSpeechAdapter } from './adapters/speech-adapter-factory';
import { DatabaseVoiceServicePersistence } from './persistence/database-voice-services';
import type {
  SpeechAdapterFactory,
  SpeechModelQuery,
  VoiceServicePersistence,
} from './ports';
import { createDefaultSpeechSynthesizer } from './services/piper.service';
import { PiperModels } from './services/piper-models.service';
import type { SpeechSynthesizer } from './services/speech-synthesizer';
import { TtsService as TtsApplicationService } from './services/tts.service';

const queryModels: SpeechModelQuery = (connection, signal) =>
  new SpeachesModels(connection).list(signal);

/** Compatibility facade with the module's default implementations. */
export class TtsService extends TtsApplicationService {
  constructor(
    storage: VoiceServicePersistence = new DatabaseVoiceServicePersistence(),
    factory: SpeechAdapterFactory = createSpeechAdapter,
    defaultSpeech: () => SpeechSynthesizer = createDefaultSpeechSynthesizer,
    models: SpeechModelQuery = queryModels,
  ) {
    super(storage, factory, defaultSpeech, models);
  }
}

export const ttsService = new TtsService();

/** Bind the deployment's default readiness check when the route is installed. */
export function createDefaultSpeechStatus() {
  const models = new PiperModels();
  return () => models.status();
}
