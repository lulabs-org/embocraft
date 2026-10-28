import {
  isRepeating,
  type TaskPlan,
  type TaskPlanDraft,
  type TaskRun,
} from '@voxel/shared';
import { randomUUID } from 'node:crypto';
import { hasPlanTokenLimit } from './limits';
import { nextOccurrence } from './timing';
import type { StoredRun, TaskBook } from './types';

export { wallClockInstant } from '@voxel/shared';
export { nextOccurrence } from './timing';
export type { StoredRun, TaskBook } from './types';
export { validatePlan } from './validation';

/**
 * 判断指定运行是否已经结束（不再处于活跃/待命状态）
 */
export const endedRun = (r: Pick<TaskRun, 'status'>): boolean =>
  ['completed', 'cancelled', 'missed', 'skipped'].includes(r.status);

/**
 * 转换并提取向客户端展示的公共 TaskRun 视图（剔除敏感及运行时内部字段）
 */
export function runView(run: StoredRun): TaskRun {
  const { runtime, accountedTokens, requestId, lastBatch, ...view } = run;
  return structuredClone({
    ...view,
    requiresReassignment: runtime?.conversation.audienceExpired,
  });
}

/**
 * 提取纯净的任务草稿配置（用于快照保存或版本对比）
 */
export function planDraft(plan: TaskPlanDraft): TaskPlanDraft {
  const {
    name,
    goal,
    timing,
    timeZone,
    limits,
    totalTokenBudgetEnabled,
    totalTokenBudget,
  } = plan;
  return structuredClone({
    name,
    goal,
    timing,
    timeZone,
    limits,
    limitsMode: plan.limitsMode,
    totalTokenBudgetEnabled,
    totalTokenBudget,
  });
}

/**
 * 基于草稿创建全新任务计划实体
 */
export function newPlan(draft: TaskPlanDraft, now: number): TaskPlan {
  const plan: TaskPlan = {
    ...planDraft(draft),
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    state: 'enabled',
    reason: '',
    spentTokens: 0,
    revision: 1,
  };
  plan.nextRunAt = nextOccurrence(plan, now);
  return plan;
}

/**
 * 基于任务计划创建新的执行记录实体
 */
export function newRun(
  plan: TaskPlan,
  at: number,
  source: TaskRun['source'],
): StoredRun {
  return {
    id: randomUUID(),
    planId: plan.id,
    planRevision: plan.revision ?? 1,
    characterId: plan.characterId,
    characterName: plan.characterName,
    source,
    scheduledAt: at,
    snapshot: planDraft(plan),
    status: 'running',
    reason: '',
    totalTokens: 0,
    accountedTokens: 0,
    logs: [],
  };
}

/**
 * 查询任务簿中到期且待触发的任务计划，按下次执行时间与创建时间升序排列
 */
export function duePlans(
  book: Pick<TaskBook, 'plans'>,
  now: number,
): TaskPlan[] {
  return book.plans
    .filter(
      (p) =>
        p.state === 'enabled' &&
        p.nextRunAt !== undefined &&
        p.nextRunAt <= now,
    )
    .sort((a, b) => a.nextRunAt! - b.nextRunAt! || a.createdAt - b.createdAt);
}

/**
 * 增量结算任务执行产生的 Token，并累加到关联的任务计划中
 */
export function settleTaskUsage(
  run: StoredRun,
  taskTokens: number,
  plan?: TaskPlan,
): number {
  const delta = Math.max(0, taskTokens - run.accountedTokens);
  run.totalTokens += delta;
  if (plan) plan.spentTokens += delta;
  run.accountedTokens = taskTokens;
  return delta;
}

/**
 * 根据单次运行状态同步计划生命周期状态（额度熔断、异常暂停、一次性完成）
 * @returns 计划状态是否发生了改变
 */
export function syncPlanStateFromRun(plan: TaskPlan, run: StoredRun): boolean {
  if (
    plan.characterId !== run.characterId ||
    plan.revision !== run.planRevision
  ) {
    return false;
  }
  const before = JSON.stringify(plan);
  if (['failed', 'budget', 'needs_input', 'blocked'].includes(run.status)) {
    plan.state = 'paused';
    plan.reason = run.reason || '本次执行需要处理。';
    delete plan.nextRunAt;
  } else if (
    endedRun(run) &&
    !isRepeating(plan.timing) &&
    plan.state === 'enabled' &&
    !plan.nextRunAt
  ) {
    plan.state = 'completed';
  }
  if (
    hasPlanTokenLimit(plan) &&
    plan.spentTokens >= plan.totalTokenBudget &&
    plan.state !== 'archived'
  ) {
    plan.state = 'paused';
    plan.reason = '计划累计 token 额度已用尽，请追加额度后恢复。';
    delete plan.nextRunAt;
  }
  return before !== JSON.stringify(plan);
}
