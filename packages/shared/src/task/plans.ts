import type { TaskLimits } from './contracts';
import type { TaskRun } from './runs';
import type { TaskTiming } from './timing';

export type TaskPlanState = 'enabled' | 'paused' | 'completed' | 'archived';

export type TaskPlanDraft = {
  name: string;
  goal: string;
  timing: TaskTiming;
  timeZone: string;
  /** Per-run limits; replaced at execution start when limitsMode is inherit. */
  limits: TaskLimits;
  /** Inherit the character's limits or use this plan's override. Missing means override. */
  limitsMode?: 'inherit' | 'override';
  /** Enable the cumulative budget; missing falls back to limits.enabled !== false. */
  totalTokenBudgetEnabled?: boolean;
  /** Cumulative token budget across runs, enforced when hasPlanTokenLimit is true. */
  totalTokenBudget: number;
};

export type TaskPlan = TaskPlanDraft & {
  id: string;
  revision?: number;
  imported?: boolean;
  createdAt: number;
  updatedAt: number;

  characterId?: string;
  characterName?: string;

  state: TaskPlanState;
  reason: string;
  nextRunAt?: number;
  /** Accumulated token usage across this plan's runs. */
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

/** Resolve cumulative-budget enforcement, including the fallback for older plans. */
export function hasPlanTokenLimit(plan: TaskPlanDraft) {
  return plan.totalTokenBudgetEnabled ?? plan.limits.enabled !== false;
}
