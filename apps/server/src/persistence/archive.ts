import type { TaskPlan } from '@voxel/shared';
import type { StoredRun } from '../modules/tasks/domain/types';
import type { CharacterRecord } from '../modules/ai-characters/persistence/record';
export type { CharacterRecord } from '../modules/ai-characters/persistence/record';

export type ManagementArchive = {
  version: 2 | 3;
  characters: CharacterRecord[];
  plans: TaskPlan[];
  runs: StoredRun[];
  requests: Record<string, string>;
};

/** Read-only shape of the previous management archive. */
type LegacyBinding<T> = Omit<T, 'characterId' | 'characterName'> & {
  agentId?: string;
  agentName?: string;
};
export type LegacyAgentArchive = {
  version: 1;
  agents: CharacterRecord[];
  plans: LegacyBinding<TaskPlan>[];
  runs: LegacyBinding<StoredRun>[];
  requests: Record<string, string>;
};

export interface ArchivePort {
  load(): Promise<
    CharacterRecord[] | LegacyAgentArchive | ManagementArchive | undefined
  >;
  save(records: ManagementArchive): Promise<void>;
}
