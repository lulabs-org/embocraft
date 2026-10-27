import type { AICharacterView, TaskPlan, TaskRun } from '@voxel/shared';
import type { AgentRunState } from '@voxel/agent-runtime';

type StoredRun = TaskRun & {
  runtime?: AgentRunState;
  accountedTokens: number;
  requestId?: string;
  lastBatch?: string;
};

type LegacyTaskBook = {
  version: 1;
  plans: TaskPlan[];
  runs: StoredRun[];
  currentRunId?: string;
  requests?: Record<string, string>;
};

/** Archive wire shape. The owning modules use structurally matching runtime types. */
export type CharacterRecord = AICharacterView & {
  runtime?: AgentRunState;
  taskBook?: LegacyTaskBook;
  currentRunId?: string;
};

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
