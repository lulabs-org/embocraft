import type { TaskPlanDraft } from './plan-draft';
import type { TaskRun } from './runs';

export type { TaskPlanDraft } from './plan-draft';

export type TaskPlanState = 'enabled' | 'paused' | 'completed' | 'archived';

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
