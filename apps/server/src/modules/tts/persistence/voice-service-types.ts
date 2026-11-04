import type { VoiceServiceDraft } from '@voxel/shared';

export type SavedVoice = VoiceServiceDraft & { id: string };

export interface VoiceServicePersistence {
  load(): Promise<SavedVoice[] | undefined>;
  save(values: SavedVoice[]): Promise<void>;
}
