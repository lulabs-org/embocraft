import type {
  SpeechAdapterFactory,
  SpeechModelQuery,
  VoiceServicePersistence,
} from '../ports';
import { AppError } from '../../../core/errors/app-error';
import { validateVoiceService } from '../domain/voice-service-validation';
import { SpeechModelsService } from './speech-models.service';
import { SpeechService } from './speech.service';
import type { ResolvedSpeech, SpeechSynthesizer } from './speech-synthesizer';
import { VoiceServiceManagement } from './voice-service-management.service';

export { validateVoiceService } from '../domain/voice-service-validation';
export type { SavedVoice } from '../domain/voice-service-validation';
export type { VoiceServicePersistence } from '../ports';

/** Application facade for the existing TTS module consumers. */
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

  /**
   * Synthesize an unsaved draft. When a saved service is referenced, its key
   * fills in a blank draft key for the same type and endpoint only, so the
   * browser never receives the stored secret. Nothing is persisted.
   */
  async preview(value: unknown, signal: AbortSignal) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new AppError('试听配置无效。');
    const input = value as Record<string, unknown>;
    const draft = input.draft;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft))
      throw new AppError('试听配置无效。');
    if (input.serviceId !== undefined && typeof input.serviceId !== 'string')
      throw new AppError('语音服务 ID 无效。');
    const text = input.text;
    if (typeof text !== 'string') throw new AppError('试听文字需为 1–240 字。');
    const previous =
      input.serviceId === undefined
        ? undefined
        : await this.management.get(input.serviceId);
    const fields = draft as Record<string, unknown>;
    // A brand-new draft may not be named yet; previewing must not require one.
    const entry = validateVoiceService(
      { ...fields, name: fields.name || 'Preview' },
      previous,
    );
    return this.speech.preview(entry, text, signal);
  }
}
