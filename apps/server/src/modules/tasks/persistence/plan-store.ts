import { isRepeating, type TaskPlan } from '@voxel/shared';
import { hasPlanTokenLimit } from '../domain/limits';
import { nextOccurrence } from '../domain/timing';
import type { StoredRun, TaskRunsPage } from '../domain/types';
import { endedRun, runView } from '../domain/model';
import { integer, object } from '../../../core/http/validation';
import { AppError } from '../../../core/errors/app-error';

/** The single owner of plans and execution history, independent of Agent lifetime. */
export class TaskPlanService {
  plans: TaskPlan[] = [];
  runs: StoredRun[] = [];
  requests: Record<string, string> = {};
  get(id: string) {
    const p = this.plans.find((p) => p.id === id);
    if (!p) throw new AppError('计划不存在。', 404);
    return p;
  }
  run(id: string) {
    const r = this.runs.find((r) => r.id === id);
    if (!r) throw new AppError('执行不存在。', 404);
    return r;
  }
  assertBinding(planId: string, characterId: string) {
    if (this.get(planId).characterId !== characterId)
      throw new AppError('计划执行角色已改变，请刷新后重试。', 409);
  }
  assertRevision(id: string, revision: number | undefined) {
    if (this.get(id).revision !== revision)
      throw new AppError('计划已改变，请刷新后重试。', 409);
  }
  unfinished(id: string) {
    return this.runs.some(
      (r) => r.planId === id && r.source !== 'chat' && !endedRun(r),
    );
  }
  touch(p: TaskPlan) {
    p.revision = (p.revision ?? 1) + 1;
    p.updatedAt = Date.now();
  }
  cancelQueued(id: string, reason: string) {
    for (const run of this.runs.filter(
      (r) => r.planId === id && r.status === 'queued',
    )) {
      run.status = 'cancelled';
      run.reason = reason;
      run.finishedAt = Date.now();
    }
  }
  reassign(id: string, agent: { id: string; name: string }) {
    const p = this.get(id);
    if (p.state === 'archived') throw new AppError('已归档计划不能改派。', 409);
    if (
      this.runs.some(
        (r) => r.planId === id && r.status !== 'queued' && !endedRun(r),
      )
    )
      throw new AppError('请先结束该计划所有未结束的执行。', 409);
    this.cancelQueued(id, '计划已重新指派。');
    p.characterId = agent.id;
    p.characterName = agent.name;
    p.state = 'paused';
    p.reason = '执行角色已改变，请明确启用或立即执行。';
    delete p.nextRunAt;
    this.touch(p);
    return structuredClone(p);
  }
  control(id: string, operation: string, value: unknown) {
    const plan = this.get(id);
    if (plan.state === 'archived') throw new AppError('计划已归档。');
    if (operation === 'resume' && !plan.characterId)
      throw new AppError('请先指派执行角色。', 409);
    if (operation === 'pause' || operation === 'archive')
      this.cancelQueued(id, '计划已暂停或归档。');
    if (operation === 'pause') {
      plan.state = 'paused';
      plan.reason = '计划已暂停，本次执行不受影响。';
      delete plan.nextRunAt;
    } else if (operation === 'resume') {
      if (!isRepeating(plan.timing) && plan.timing.kind !== 'once')
        throw new AppError('一次性任务请使用立即执行。');
      if (
        this.runs.some(
          (r) =>
            r.planId === id &&
            ['failed', 'blocked', 'needs_input', 'budget'].includes(r.status),
        )
      )
        throw new AppError('请先处理或结束异常执行。');
      if (hasPlanTokenLimit(plan) && plan.spentTokens >= plan.totalTokenBudget)
        throw new AppError('请先追加计划累计额度。');
      plan.nextRunAt = nextOccurrence(plan, Date.now());
      if (!plan.nextRunAt)
        throw new AppError('指定时间已错过，请编辑未来时间或手动执行。');
      plan.state = 'enabled';
      plan.reason = '';
    } else if (operation === 'archive') {
      if (this.runs.some((r) => r.planId === id && !endedRun(r)))
        throw new AppError('请先结束所有未完成的执行。', 409);
      plan.state = 'archived';
      plan.reason = '计划已归档，执行历史保留。';
      delete plan.nextRunAt;
    } else if (operation === 'extend') {
      const amount = integer(
        object(value).tokens,
        '追加 token 额度',
        0,
        1000,
        1000000000,
      );
      if (plan.totalTokenBudget + amount > 1000000000)
        throw new AppError('累计额度过大。');
      plan.totalTokenBudget += amount;
    } else throw new AppError('计划操作无效。');
    this.touch(plan);
    return structuredClone(plan);
  }
  detach(characterId: string, name?: string) {
    for (const p of this.plans.filter((p) => p.characterId === characterId)) {
      if (name) p.characterName = name;
      delete p.characterId;
      if (!['completed', 'archived'].includes(p.state)) {
        p.state = 'paused';
        p.reason = '执行角色已删除，请重新指派。';
        delete p.nextRunAt;
      }
      this.touch(p);
    }
  }
  views(characterId?: string) {
    return this.plans
      .filter((p) => !characterId || p.characterId === characterId)
      .map((p) => {
        const latest = this.runs
          .filter((r) => r.planId === p.id && r.source !== 'chat')
          .at(-1);
        return {
          ...structuredClone(p),
          latestRun: latest
            ? { ...runView(latest), logs: [], actions: undefined }
            : undefined,
        };
      });
  }
  history(planId: string, offset = 0): TaskRunsPage {
    this.get(planId);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new AppError('分页参数无效。');
    const all = this.runs
      .filter((r) => r.planId === planId && r.source !== 'chat')
      .slice()
      .reverse();
    return {
      items: all.slice(offset, offset + 20).map(runView),
      active: all.filter((r) => !endedRun(r)).map(runView),
      total: all.length,
      nextOffset: offset + 20 < all.length ? offset + 20 : undefined,
    };
  }
}

export { TaskPlanService as PlanService };
