import type { AICharacterTask, AICharacterTaskStatus } from './contracts';
import type { TaskPlanDraft } from './plans';

/** Execution task states plus outcomes managed by scheduling and run orchestration. */
export type TaskRunStatus =
  | AICharacterTaskStatus
  | 'queued'
  | 'failed'
  | 'missed'
  | 'skipped';

export type TaskRunAction = {
  /** Action start time; absent for legacy or pending actions. */
  startedAt?: number;
  batchId?: string;
  call: number;
  index: number;
  kind: string;
  status: string;
  detail: string;
};

export type TaskRun = {
  id: string;
  planId?: string;
  planRevision?: number;
  characterId?: string;
  characterName?: string;
  /** `legacy` is retained solely as provenance of already imported v3 run history. */
  source: 'scheduled' | 'manual' | 'chat' | 'legacy';
  scheduledAt: number;
  eventId?: string;
  coalescedTriggers?: number;
  lastTriggerAt?: number;
  startedAt?: number;
  finishedAt?: number;
  snapshot: TaskPlanDraft;
  status: TaskRunStatus;
  reason: string;
  task?: AICharacterTask;
  totalTokens: number;
  logs: string[];
  actions?: TaskRunAction[];
  requiresReassignment?: boolean;
};

export type TaskRunPage = {
  items: TaskRun[];
  active: TaskRun[];
  total: number;
  nextOffset?: number;
};
