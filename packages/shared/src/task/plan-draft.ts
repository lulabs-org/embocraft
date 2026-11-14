import type { TaskLimits } from './contracts';
import type { TaskTiming } from './timing';

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
