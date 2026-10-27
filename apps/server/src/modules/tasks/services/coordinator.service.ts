import { PlanService } from '../persistence/plan-store';
import { TaskScheduler } from './scheduler.service';
import { validatePlan } from '../domain/validation';
import {
  newPlan,
  nextOccurrence,
  duePlans,
  runView,
  endedRun,
} from '../domain/model';
import { TaskService, recordEvent, type TaskLease } from '@voxel/agent-runtime';
import type { WorldEvent } from '@voxel/shared';
import { CommandQueue } from '../../../core/concurrency/command-queue';
import { isRepeating } from '@voxel/shared';
import { hasPlanTokenLimit } from '../domain/limits';
import type { PlanQueryFilter } from '@voxel/shared/management';
import { object } from '../../../core/http/validation';
import { AppError } from '../../../core/errors/app-error';
import type { TaskExecutionState, TaskHostPort } from '../ports';
import {
  commitExecution,
  captureTask,
  currentRun,
  getTaskPlans,
  getTaskRuns,
  reserveRun,
  startQueuedRun,
  taskBusy,
  executeTaskPlanControl,
  executeTaskRunControl,
} from './execution.service';
export class TaskCoordinator {
  readonly plans = new PlanService();
  readonly committedPlans = new PlanService();
  readonly planScheduler: TaskScheduler;
  private changingPlans = new Set<string>();
  private readonly messageCommands = new CommandQueue({
    // Internal commands return the original promise; no public receipt error DTO is needed.
    publicError: () => undefined,
    conflict: () =>
      new AppError('同一命令标识不能用于不同操作。', 409, 'CONFLICT'),
  });

  constructor(private readonly host: TaskHostPort) {
    this.planScheduler = new TaskScheduler(() => this.dispatchDue());
  }

  publicPlans(id?: string, metadata = false) {
    const plans = this.committedPlans.views(id).map((p) => ({
      ...p,
      characterName: p.characterId
        ? (this.host.committedName(p.characterId) ?? p.characterName)
        : p.characterName,
    }));
    return metadata
      ? plans.map((plan) => ({
          ...plan,
          resourceVersion: this.host.resourceVersion(),
          taskIdentity: plan.characterId
            ? (this.host.publicIdentity(plan.characterId) ?? null)
            : null,
        }))
      : plans;
  }

  publicRuns(
    id: string | undefined,
    plan: string,
    offset?: number,
    metadata = false,
  ) {
    if (id) this.committedPlans.assertBinding(plan, id);
    const page = this.committedPlans.history(plan, offset);
    if (!metadata) return page;
    const annotate = (run: (typeof page.items)[number]) => ({
      ...run,
      resourceVersion: this.host.resourceVersion(),
      taskIdentity: run.characterId
        ? (this.host.publicIdentity(run.characterId) ?? null)
        : null,
    });
    return {
      ...page,
      resourceVersion: this.host.resourceVersion(),
      items: page.items.map(annotate),
      active: page.active.map(annotate),
    };
  }

  planPage(p: PlanQueryFilter) {
    if (
      p.offset !== undefined &&
      (!Number.isSafeInteger(p.offset) || p.offset < 0)
    )
      throw new AppError('分页参数无效。');
    if (
      p.search !== undefined &&
      (typeof p.search !== 'string' || p.search.length > 80)
    )
      throw new AppError('搜索条件无效。');
    if (
      p.state !== undefined &&
      !['enabled', 'paused', 'completed', 'archived', 'unassigned'].includes(
        p.state,
      )
    )
      throw new AppError('计划状态无效。');
    if (
      p.timing !== undefined &&
      !['immediate', 'once', 'interval', 'daily', 'weekly'].includes(p.timing)
    )
      throw new AppError('执行方式无效。');
    let all = this.publicPlans(p.characterId, true).filter(
      (plan) =>
        (!p.search ||
          plan.name
            .toLocaleLowerCase()
            .includes(p.search.toLocaleLowerCase())) &&
        (!p.state ||
          (p.state === 'unassigned'
            ? !plan.characterId && plan.state === 'paused'
            : plan.state === p.state)) &&
        (!p.timing || plan.timing.kind === p.timing),
    );
    if (!p.state) all = all.filter((plan) => plan.state !== 'archived');
    all.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const offset = p.offset ?? 0;
    return {
      items: all.slice(offset, offset + 20),
      total: all.length,
      nextOffset: offset + 20 < all.length ? offset + 20 : undefined,
    };
  }

  publicPlan(id: string) {
    const p = this.publicPlans(undefined, true).find((p) => p.id === id);
    if (!p) throw new AppError('计划不存在。', 404);
    return p;
  }

  async reassignPlan(id: string, characterId: string, value: unknown = {}) {
    this.checkPlanRevision(id, value);
    const agent = this.host.execution(characterId);
    return this.commitPlan(id, () => this.plans.reassign(id, agent.view));
  }

  taskPlans(id: string) {
    return getTaskPlans(this.host.execution(id));
  }

  taskRuns(id: string, planId: string, offset = 0) {
    return getTaskRuns(this.host.execution(id), planId, offset);
  }

  async createTaskPlan(id: string, value: unknown) {
    this.host.assertWritable(id);
    if (this.host.storageFailed())
      throw new AppError('计划存档失败，请修复存储后重启。', 503);
    const job = this.host.execution(id);
    const requestId = object(value).requestId;
    if (
      requestId !== undefined &&
      (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId))
    )
      throw new AppError('请求标识无效。');
    const priorId =
      typeof requestId === 'string' &&
      job.ledger.requests &&
      Object.hasOwn(job.ledger.requests, `${id}:${requestId}`)
        ? job.ledger.requests[`${id}:${requestId}`]
        : undefined;
    if (priorId)
      return structuredClone(job.ledger.plans.find((p) => p.id === priorId)!);
    const draft = validatePlan(value);
    if (draft.timing.kind === 'immediate' && !job.online)
      throw new AppError('请先让角色上线。', 409);
    let runId: string | undefined;
    const plan = await commitExecution(
      job,
      () => {
        const p = {
          ...newPlan(draft, Date.now()),
          characterId: id,
          characterName: job.view.name,
        };
        job.ledger.plans.push(p);
        if (p.timing.kind === 'immediate')
          runId = reserveRun(job, p, 'manual', Date.now());
        if (typeof requestId === 'string')
          job.ledger.requests[`${id}:${requestId}`] = p.id;
        return p;
      },
      () => this.host.save(),
      (j) => this.host.schedule(j.view.id),
      draft.timing.kind === 'immediate',
    );
    if (runId) this.host.launch(job.view.id);
    this.planScheduler.start();
    return structuredClone(plan);
  }

  private async commitPlan<T>(planId: string, change: () => T) {
    if (this.host.storageFailed())
      throw new AppError('计划存档失败，请修复存储后重启。', 503);
    const bound = this.plans.get(planId).characterId;
    if (
      this.changingPlans.has(planId) ||
      (bound && this.host.findExecution(bound)?.taskMutating)
    )
      throw new AppError('计划正在提交，请稍后重试。', 409);
    this.changingPlans.add(planId);
    const before = structuredClone(this.plans.get(planId));
    const beforeRuns = structuredClone(
      this.plans.runs.filter((r) => r.planId === planId),
    );
    try {
      const value = change();
      await this.host.save();
      return value;
    } catch (e) {
      this.plans.plans[this.plans.plans.findIndex((p) => p.id === planId)] =
        before;
      this.plans.runs = [
        ...this.plans.runs.filter((r) => r.planId !== planId),
        ...beforeRuns,
      ];
      throw e;
    } finally {
      this.changingPlans.delete(planId);
    }
  }

  async updateTaskPlan(id: string | undefined, planId: string, value: unknown) {
    const plan = this.plans.get(planId);
    this.checkPlanRevision(planId, value);
    if (id) this.plans.assertBinding(planId, id);
    if (plan.state === 'archived') throw new AppError('已归档任务不能修改。');
    const draft = validatePlan(value, Date.now(), plan);
    const targetCharacterId = object(value).targetCharacterId;
    const target =
      targetCharacterId !== undefined && targetCharacterId !== plan.characterId
        ? this.host.execution(String(targetCharacterId))
        : undefined;
    return this.commitPlan(planId, () => {
      if (target) this.plans.reassign(planId, target.view);
      Object.assign(plan, draft);
      this.plans.touch(plan);
      plan.nextRunAt =
        plan.state === 'enabled' ? nextOccurrence(plan, Date.now()) : undefined;
      return structuredClone(plan);
    });
  }

  async controlTaskPlan(
    id: string | undefined,
    planId: string,
    operation: string,
    value: unknown = {},
  ) {
    if (id) this.plans.assertBinding(planId, id);
    this.checkPlanRevision(planId, value);
    if (operation !== 'run')
      return this.commitPlan(planId, () =>
        this.plans.control(planId, operation, value),
      );
    const target = this.plans.get(planId).characterId;
    if (!target) throw new AppError('请先指派执行角色。', 409);
    this.checkTaskRevision(target, value);
    return executeTaskPlanControl(
      this.host.execution(target),
      planId,
      operation,
      value,
      () => this.host.save(),
      (j) => this.host.schedule(j.view.id),
      (j) => this.host.launch(j.view.id),
    );
  }

  async controlTaskRun(
    id: string | undefined,
    runId: string,
    operation: string,
    value: unknown = {},
  ) {
    const targetId = id || this.plans.run(runId).characterId;
    if (!targetId) throw new AppError('任务未关联执行角色。', 404);
    if (this.plans.run(runId).characterId !== targetId)
      throw new AppError('执行角色不匹配。', 409);
    if (this.plans.run(runId).status !== 'queued')
      this.checkTaskRevision(targetId, value);
    const job = this.host.execution(targetId);
    return executeTaskRunControl(
      job,
      runId,
      operation,
      value,
      (settings) => this.host.validateExecution(targetId, settings),
      () => this.host.save(),
      (j) => this.host.schedule(j.view.id),
      (j) => this.host.launch(j.view.id),
      (op) => this.controlCurrentRun(job, runId, op),
    );
  }

  private checkPlanRevision(id: string, value: unknown) {
    const expected = object(value).expectedPlanRevision;
    if (expected !== undefined)
      this.plans.assertRevision(id, expected as number);
  }

  private checkTaskRevision(id: string, value: unknown) {
    const expected = object(value).expectedTask;
    if (expected === undefined) return; // Existing HTTP callers may omit preconditions.
    const current = this.host.execution(id).memory.task.identity ?? null;
    if (
      expected === null
        ? current !== null
        : !current ||
          typeof expected !== 'object' ||
          (expected as { id?: unknown }).id !== current.id ||
          (expected as { revision?: unknown }).revision !== current.revision ||
          (expected as { startedAt?: unknown }).startedAt !== current.startedAt
    )
      throw new AppError('任务已改变，请刷新后重试。', 409);
  }

  /** Trusted world messages retain their player authority; never promote them to operator commands. */
  controlMessage(
    id: string,
    operation: 'pause' | 'cancel',
    lease: TaskLease,
    commandId: string,
    message: WorldEvent,
  ) {
    lease = structuredClone(lease);
    message = structuredClone(message);
    const state = this.host.execution(id);
    let runId: string | undefined;
    const verify = () => {
      const tasks = new TaskService(state.memory);
      tasks.assertCurrent(lease);
      tasks.authorize({ kind: 'player', message });
      if (runId && state.currentRunId !== runId)
        throw new AppError('当前执行已改变，请重新确认。', 409);
    };
    return this.messageCommands.run(
      `${id}:${commandId}`,
      { operation, lease, message },
      id,
      async () => {
        verify();
        captureTask(state);
        runId = state.currentRunId;
        if (!runId) throw new AppError('没有可控制的执行。', 409);
        return this.controlCurrentRun(state, runId, operation, verify, message);
      },
      verify,
    );
  }

  private async controlCurrentRun(
    state: TaskExecutionState,
    runId: string,
    operation: 'pause' | 'cancel',
    verify?: () => void,
    message?: WorldEvent,
  ) {
    if (state.currentRunId !== runId)
      throw new AppError('当前执行已改变。', 409);
    return this.host.withStoppedExecution(state.view.id, async () => {
      verify?.();
      if (state.currentRunId !== runId)
        throw new AppError('当前执行已改变。', 409);
      const task = state.memory.task.current;
      if (task && !['completed', 'cancelled'].includes(task.status))
        new TaskService(state.memory).command(
          { type: operation },
          message ? { kind: 'player', message } : { kind: 'operator' },
          { ...state.view, apiKey: '' },
        );
      const lease = new TaskService(state.memory).lease();
      recordEvent(state.memory, {
        id: `control:${runId}:${lease.revision}:${operation}`,
        kind: 'control',
        state: 'done',
        at: Date.now(),
        audience: task?.privateTo ?? 'public',
        actor: message?.actor,
        characterId: state.view.id,
        runId,
        taskId: lease.id,
        revision: lease.revision,
        detail: operation,
      });
      captureTask(state);
      await this.host.save();
      return runView(state.ledger.run(runId));
    });
  }

  /** Removal is coordinated with the Agent archive transaction; failure restores task bindings/history. */
  detachAgent(id: string, name: string) {
    const state = this.host.execution(id);
    captureTask(state);
    const priorPlans = structuredClone(
      this.plans.plans.filter((p) => p.characterId === id),
    );
    const priorRuns = structuredClone(
      this.plans.runs.filter((r) => r.characterId === id),
    );
    for (const run of this.plans.runs.filter(
      (r) => r.characterId === id && !endedRun(r),
    )) {
      if (run.runtime?.task.current) {
        new TaskService(run.runtime).command(
          { type: 'cancel' },
          { kind: 'operator' },
          { ...state.view, apiKey: '' },
        );
        delete run.runtime.effects.follow;
        run.task = structuredClone(run.runtime.task.current);
      }
      run.status = 'cancelled';
      run.reason = '执行角色已删除。';
      run.finishedAt = Date.now();
    }
    this.plans.detach(id, name);
    return () => {
      for (const plan of priorPlans) {
        const index = this.plans.plans.findIndex((p) => p.id === plan.id);
        this.plans.plans[index] = plan;
      }
      this.plans.runs = [
        ...this.plans.runs.filter((r) => r.characterId !== id),
        ...priorRuns,
      ];
    };
  }

  pauseForShutdown(id: string) {
    const state = this.host.findExecution(id);
    if (!state) return;
    if (
      !['running', 'waiting'].includes(state.memory.task.current?.status ?? '')
    )
      return;
    const run = currentRun(state),
      plan = this.plans.plans.find((p) => p.id === run?.planId);
    if (plan) {
      plan.state = 'paused';
      plan.reason = '服务关闭，进度保留，请手动继续。';
      delete plan.nextRunAt;
    }
  }

  async dispatchDue(now = Date.now()) {
    if (this.host.isClosing() || this.host.storageFailed()) return;
    for (const job of this.host.executions()) {
      if (
        job.storageFailed ||
        job.taskMutating ||
        job.updating ||
        job.controlling
      )
        continue;
      const due = duePlans(job.ledger, now).filter(
        (p) => p.characterId === job.view.id,
      );

      for (const plan of due) {
        if (this.changingPlans.has(plan.id)) continue;
        const at = plan.nextRunAt!;
        const skip = !job.online ? '角色离线，本次触发已错过。' : undefined;
        let runId: string | undefined;
        await commitExecution(
          job,
          () => {
            if (
              hasPlanTokenLimit(plan) &&
              plan.spentTokens >= plan.totalTokenBudget
            ) {
              plan.state = 'paused';
              plan.reason = '累计额度已用尽。';
              delete plan.nextRunAt;
              return;
            }
            runId = reserveRun(job, plan, 'scheduled', at, skip);
            plan.nextRunAt = isRepeating(plan.timing)
              ? nextOccurrence(plan, now)
              : undefined;
          },
          () => this.host.save(),
          (j) => this.host.schedule(j.view.id),
          !skip,
        );
        if (runId) {
          this.host.launch(job.view.id);
        }
      }
      const queued = job.ledger.runs
        .filter((r) => r.characterId === job.view.id && r.status === 'queued')
        .sort(
          (a, b) => a.scheduledAt - b.scheduledAt || a.id.localeCompare(b.id),
        );
      if (
        queued.length &&
        job.online &&
        !taskBusy(job) &&
        (!job.memory.task.current ||
          ['completed', 'cancelled'].includes(job.memory.task.current.status))
      ) {
        const runId = await commitExecution(
          job,
          () => startQueuedRun(job, queued[0].id),
          () => this.host.save(),
          (j) => this.host.schedule(j.view.id),
          true,
        );
        if (runId) this.host.launch(job.view.id);
      }
    }
  }
}
