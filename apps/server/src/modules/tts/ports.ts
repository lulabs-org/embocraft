import type { SpeachesModel, VoiceServiceDraft } from '@voxel/shared';
import type { SpeechSynthesizer } from './services/speech-synthesizer';
import type { SavedVoice } from './domain/voice-service-validation';

export interface VoiceServiceTransaction {
  get(id: string): Promise<SavedVoice | undefined>;
  count(): Promise<number>;
  create(value: SavedVoice): Promise<void>;
  update(value: SavedVoice): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface VoiceServicePersistence {
  load(): Promise<SavedVoice[]>;
  get(id: string): Promise<SavedVoice | undefined>;
  transaction<T>(run: (tx: VoiceServiceTransaction) => Promise<T>): Promise<T>;
}

export type SpeechAdapterFactory = (value: SavedVoice) => SpeechSynthesizer;

export type SpeechModelQuery = (
  connection: Pick<VoiceServiceDraft, 'baseUrl' | 'apiKey'>,
  signal?: AbortSignal,
) => Promise<SpeachesModel[]>;

/** In-process deletion guards and post-commit runtime notification. */
export interface VoiceServiceCoordination {
  withRemoval<T>(id: string, operation: () => Promise<T>): Promise<T>;
  assertRemovable(id: string): void;
  notifyChanged(id: string): boolean;
}
