import type { RuntimeState } from '@voxel/agent-runtime';
import type {
  AICharacterLogEntry,
  AICharacterSettings,
  TaskPlan,
  TaskRun,
} from '@voxel/shared';

type StoredRun = TaskRun & {
  runtime?: RuntimeState;
  accountedTokens: number;
  requestId?: string;
  lastBatch?: string;
};

/** Durable character data. Public summaries are rebuilt from this and the task ledger. */
export type CharacterRecord = AICharacterSettings & {
  id: string;
  createdAt: number;
  status:
    | 'joining'
    | 'running'
    | 'idle'
    | 'stopping'
    | 'stopped'
    | 'completed'
    | 'failed';
  logEntries: AICharacterLogEntry[];
  /** Authoritative current runtime, including cumulative character usage. */
  runtime?: RuntimeState;
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
  /** Returns hydrated snapshots; storage references must not escape the adapter. */
  load(): Promise<ManagementArchive | undefined>;
  save(records: ManagementArchive): Promise<void>;
}
