import type {
  SpeechAdapterFactory,
  SpeechModelQuery,
  VoiceServicePersistence,
} from '../ports';
import { SpeechModelsService } from './speech-models.service';
import { SpeechService } from './speech.service';
import type { ResolvedSpeech, SpeechSynthesizer } from './speech-synthesizer';
import { VoiceServiceManagement } from './voice-service-management.service';

/** Coordinates voice configuration, model discovery and speech synthesis. */
export class TtsService {
  private readonly management: VoiceServiceManagement;
  private readonly modelDiscovery: SpeechModelsService;
  private readonly speech: SpeechService;

  constructor(
    storage: VoiceServicePersistence,
    factory: SpeechAdapterFactory,
    private readonly defaultSpeech: () => SpeechSynthesizer,
    queryModels: SpeechModelQuery,
  ) {
    this.management = new VoiceServiceManagement(storage);
    const getVoice = (id: string) => this.get(id);
    this.modelDiscovery = new SpeechModelsService(getVoice, queryModels);
    this.speech = new SpeechService(getVoice, factory);
  }

  models(value: unknown, signal?: AbortSignal) {
    return this.modelDiscovery.models(value, signal);
  }

  list() {
    return this.management.list();
  }

  get(id: string) {
    return this.management.get(id);
  }

  save(value: unknown, id?: string) {
    return this.management.save(value, id);
  }

  remove(id: string) {
    return this.management.remove(id);
  }

  /** Resolve unmanaged, disabled, or saved voice bindings without changing their limits. */
  resolveSpeech(id: string | undefined): Promise<ResolvedSpeech> {
    if (id === undefined)
      return Promise.resolve({
        kind: 'server',
        synthesizer: this.defaultSpeech(),
      });
    if (id === '')
      return Promise.resolve({
        kind: 'server',
        synthesizer: {
          synthesize: (text, signal) => this.synthesize(id, text, signal),
        },
      });
    return this.synthesizer(id);
  }

  synthesizer(id: string) {
    return this.speech.synthesizer(id);
  }

  synthesize(id: string, text: string, signal: AbortSignal) {
    return this.speech.synthesize(id, text, signal);
  }
}
