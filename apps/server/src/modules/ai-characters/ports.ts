import type { AICharacterLogEntry, AICharacterSummary } from '@voxel/shared';
import type { TaskIdentity } from '@voxel/shared/management';

export type CharacterDetail = AICharacterSummary & {
  taskIdentity: TaskIdentity | null;
};

export interface CharacterQueryPort {
  get(id: string): Promise<CharacterDetail>;
  list(): Promise<CharacterDetail[]>;
  logs(
    id: string,
    limit: number,
    offset: number,
  ): Promise<{
    entries: AICharacterLogEntry[];
    total: number;
  }>;
}
