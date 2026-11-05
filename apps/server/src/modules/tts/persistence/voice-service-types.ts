import type { VoiceServiceDraft } from '@voxel/shared';

export type SavedVoice = VoiceServiceDraft & { id: string };

export interface VoiceServicePersistence {
  load(): Promise<SavedVoice[]>;
  update<T>(
    change: (values: SavedVoice[]) => {
      values: SavedVoice[];
      result: T;
    },
  ): Promise<T>;
}
