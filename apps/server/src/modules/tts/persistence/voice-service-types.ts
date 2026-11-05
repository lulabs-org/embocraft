import type { VoiceServiceDraft } from '@voxel/shared';

export type SavedVoice = VoiceServiceDraft & { id: string };

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
