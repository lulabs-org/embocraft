import type {
  TaskLimits,
  AICharacterTask,
  AICharacterTaskStatus,
} from './contracts';

export type TaskTiming =
  | { kind: 'immediate' }
  | { kind: 'once'; at: number }
  | { kind: 'interval'; everyMs: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; weekdays: number[] };
export type TaskPlanDraft = {
  name: string;
  goal: string;
  timing: TaskTiming;
  timeZone: string;
  limits: TaskLimits;
  /** Missing on existing plans means an explicit override. */
  limitsMode?: 'inherit' | 'override';
  /** Missing on existing plans keeps the former per-run-limit coupling. */
  totalTokenBudgetEnabled?: boolean;
  totalTokenBudget: number;
};
export type TaskPlan = TaskPlanDraft & {
  characterId?: string;
  characterName?: string;
  revision?: number;
  imported?: boolean;
  id: string;
  createdAt: number;
  updatedAt: number;
  state: 'enabled' | 'paused' | 'completed' | 'archived';
  reason: string;
  nextRunAt?: number;
  spentTokens: number;
  latestRun?: TaskRun;
};
/** Fields needed to render a plan in the paginated management list. */
export type TaskPlanSummary = Pick<
  TaskPlan,
  | 'id'
  | 'name'
  | 'timing'
  | 'timeZone'
  | 'state'
  | 'characterId'
  | 'characterName'
>;
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
  status: AICharacterTaskStatus | 'queued' | 'failed' | 'missed' | 'skipped';
  reason: string;
  task?: AICharacterTask;
  totalTokens: number;
  logs: string[];
  actions?: {
    /** Action start time; absent for legacy or pending actions. */
    startedAt?: number;
    batchId?: string;
    call: number;
    index: number;
    kind: string;
    status: string;
    detail: string;
  }[];
  requiresReassignment?: boolean;
};
export type TaskRunPage = {
  items: TaskRun[];
  active: TaskRun[];
  total: number;
  nextOffset?: number;
};
export const DEFAULT_TASK_LIMITS: TaskLimits = {
  maxTurns: 100,
  maxStalledTurns: 3,
  tokenBudget: 50000,
  taskTimeoutMs: 900000,
};
export function isRepeating(timing: TaskTiming) {
  return ['interval', 'daily', 'weekly'].includes(timing.kind);
}
export function hasPlanTokenLimit(plan: TaskPlanDraft) {
  return plan.totalTokenBudgetEnabled ?? plan.limits.enabled !== false;
}
