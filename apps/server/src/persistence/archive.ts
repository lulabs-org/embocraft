import type { AICharacterView, TaskPlan, TaskRun } from '@voxel/shared';
import type { AgentRunState } from '@voxel/agent-runtime';

type StoredRun = TaskRun & {
  runtime?: AgentRunState;
  accountedTokens: number;
  requestId?: string;
  lastBatch?: string;
};

/** Archive wire shape. The owning modules use structurally matching runtime types. */
export type CharacterRecord = AICharacterView & {
  runtime?: AgentRunState;
  currentRunId?: string;
};

export type ManagementArchive = {
  version: 3;
  characters: CharacterRecord[];
  plans: TaskPlan[];
  runs: StoredRun[];
  requests: Record<string, string>;
};

export interface ArchivePort {
  load(): Promise<ManagementArchive | undefined>;
  save(records: ManagementArchive): Promise<void>;
}
