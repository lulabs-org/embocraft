import {
  AgentRuntimeError,
  createAgentRuntime,
  runtimeView,
  type AgentConfig,
  type AgentRuntime,
  type RuntimeState,
} from '@voxel/agent-runtime';
import { isRepeating, type TaskPlan, type TaskRun } from '@voxel/shared';
import { executionLimits, hasPlanTokenLimit } from '../domain/limits';
import {
  endedRun,
  newRun,
  runView,
  settleTaskUsage,
  syncPlanStateFromRun,
} from '../domain/model';

import type { AICharacterSettings } from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import { object } from '../../../core/http/validation';
import { taskLimits } from '../domain/validation';
import type { TaskExecutionState } from '../ports';
const active = (status: TaskExecutionState['view']['status']) =>
  ['joining', 'running', 'stopping'].includes(status);

export function currentRun(job: TaskExecutionState) {
  return job.ledger.runs.find((r) => r.id === job.currentRunId);
}

export function taskBusy(job: TaskExecutionState) {
  const run = currentRun(job);
  return (
    !!job.taskMutating ||
    job.updating ||
    job.controlling ||
    active(job.view.status) ||
    (!!run &&
      ['running', 'waiting'].includes(run.status) &&
      job.view.status !== 'failed')
  );
}

export function captureTask(
  job: TaskExecutionState,
  runtime: AgentRuntime = job.runtime,
) {
  runtime.reconcilePlanEvents((id) => {
    const run = job.ledger.runs.find((r) => r.id === id);
    return run ? { ended: endedRun(run), reason: run.reason } : undefined;
  });
  const record = runtime.executionRecord();
  const task = record.task;
  if (!task) return;
  let run = currentRun(job);
  if (!run || (run.task && run.task.startedAt !== task.startedAt)) {
    const snapshot = {
      name: task.goal.slice(0, 80) || '聊天执行',
      goal: task.goal,
      timing: { kind: 'immediate' as const },
      timeZone: 'UTC',
      limits: {
        enabled: job.view.taskLimitsEnabled !== false,
        maxTurns: job.view.maxTurns,
        maxStalledTurns: job.view.maxStalledTurns ?? 3,
        tokenBudget: job.view.tokenBudget ?? 50000,
        taskTimeoutMs: job.view.taskTimeoutMs ?? 900000,
      },
      totalTokenBudget: 500000,
    };
    run = newRun(
      {
        ...snapshot,
        id: '',
        createdAt: task.startedAt,
        updatedAt: task.startedAt,
        state: 'enabled',
        reason: '',
        spentTokens: 0,
      },
      task.startedAt,
      'chat',
    );
    delete run.planId;
    run.characterId = job.view.id;
    run.characterName = job.view.name;
    run.logs = job.view.logEntries.map((entry) => entry.text);
    job.ledger.runs.push(run);
    job.currentRunId = run.id;
  }
  const plan = job.ledger.plans.find((p) => p.id === run!.planId);
  settleTaskUsage(run!, task.tokens, plan);
  const batch = record.batch;
  if (
    Array.isArray(batch?.results) &&
    JSON.stringify(batch) !== run.lastBatch
  ) {
    run.lastBatch = JSON.stringify(batch);
    const call = record.calls ?? task.calls;
    run.actions ??= [];
    batch.results.forEach((result, index) => {
      if (!result.action?.type || !result.status) return;
      const entry = {
        startedAt: result.startedAt,
        batchId: batch.batchId,
        call,
        index,
        kind: result.action.type,
        status: result.status,
        detail: JSON.stringify({
          action: result.action,
          result: result.result,
        }),
      };
      const existing = run!.actions!.findIndex(
        (a) =>
          a.call === call && a.index === index && a.batchId === batch.batchId,
      );
      if (existing < 0) run!.actions!.push(entry);
      else run!.actions![existing] = entry;
    });
  }
  run.task = structuredClone(task);
  run.runtime = runtime.executionSnapshot();
  run.startedAt ??= task.startedAt;
  run.status =
    job.view.status === 'failed' &&
    !['completed', 'cancelled', 'budget'].includes(task.status)
      ? 'failed'
      : task.status;
  run.reason =
    run.status === 'failed'
      ? job.view.logEntries.at(-1)?.text || '执行中断，请检查后继续。'
      : task.reason;
  if (endedRun(run)) run.finishedAt ??= Date.now();
  // Historical results still contribute usage, but cannot overwrite newer plan controls.
  if (plan && syncPlanStateFromRun(plan, run)) {
    job.ledger.touch(plan);
  }
}

export async function commitExecution<T>(
  job: TaskExecutionState,
  change: () => T,
  save: () => Promise<void>,
  schedule: (job: TaskExecutionState) => void,
  swapsExecution = false,
): Promise<T> {
  if (job.taskMutating || job.updating || job.controlling)
    throw new AppError('任务状态正在更新，请稍候。', 409);
  captureTask(job);
  const epochBeforeChange = job.runtime.stateEpoch;
  const before = {
    plans: structuredClone(
      job.ledger.plans.filter((p) => p.characterId === job.view.id),
    ),
    runs: structuredClone(
      job.ledger.runs.filter((r) => r.characterId === job.view.id),
    ),
    currentRunId: job.currentRunId,
    requests: Object.fromEntries(
      Object.entries(job.ledger.requests).filter(([k]) =>
        k.startsWith(job.view.id + ':'),
      ),
    ),
    memory: job.runtime.snapshot(),
    view: structuredClone(job.view),
  };
  job.taskMutating = true;
  try {
    const result = change();
    await save();
    return result;
  } catch (error) {
    job.ledger.plans = [
      ...job.ledger.plans.filter((p) => p.characterId !== job.view.id),
      ...before.plans,
    ];
    job.ledger.runs = [
      ...job.ledger.runs.filter((r) => r.characterId !== job.view.id),
      ...before.runs,
    ];
    job.ledger.requests = {
      ...Object.fromEntries(
        Object.entries(job.ledger.requests).filter(
          ([k]) => !k.startsWith(job.view.id + ':'),
        ),
      ),
      ...before.requests,
    };
    job.currentRunId = before.currentRunId;
    if (swapsExecution && job.runtime.stateEpoch !== epochBeforeChange) {
      job.runtime.rollback(before.memory, true);
      job.view = before.view;
    } else captureTask(job);
    throw error;
  } finally {
    job.taskMutating = false;
    schedule(job);
  }
}

export function getTaskPlans(job: TaskExecutionState) {
  captureTask(job);
  return job.ledger.views(job.view.id);
}
export function getTaskRuns(
  job: TaskExecutionState,
  planId: string,
  offset = 0,
) {
  captureTask(job);
  job.ledger.assertBinding(planId, job.view.id);
  return job.ledger.history(planId, offset);
}

export function reserveRun(
  job: TaskExecutionState,
  plan: TaskPlan,
  source: TaskRun['source'],
  at: number,
  skip?: string,
) {
  if (
    source === 'scheduled' &&
    job.ledger.runs.some(
      (r) =>
        r.planId === plan.id &&
        r.planRevision === (plan.revision ?? 1) &&
        r.source === source &&
        (r.scheduledAt === at ||
          (r.scheduledAt < at && (r.lastTriggerAt ?? 0) >= at)),
    )
  )
    return undefined;
  captureTask(job);
  const run = newRun({ ...plan, characterName: job.view.name }, at, source);
  job.ledger.runs.push(run);
  if (skip) {
    run.status = isRepeating(plan.timing) ? 'skipped' : 'missed';
    run.reason = skip;
    run.finishedAt = Date.now();
    if (!isRepeating(plan.timing)) plan.state = 'completed';
    return undefined;
  }
  const pending = job.ledger.runs.find(
    (r) => r.id !== run.id && r.planId === plan.id && r.status === 'queued',
  );
  if (pending && source === 'scheduled') {
    job.ledger.runs.pop();
    if ((pending.lastTriggerAt ?? pending.scheduledAt) >= at) return undefined;
    pending.coalescedTriggers = (pending.coalescedTriggers ?? 0) + 1;
    pending.lastTriggerAt = at;
    return undefined;
  }
  run.status = 'queued';
  run.reason = '等待角色完成当前任务。';
  run.eventId = job.runtime.queuePlan({
    runId: run.id,
    planId: plan.id,
    revision: plan.revision ?? 1,
    characterId: job.view.id,
    at,
    goal: run.snapshot.goal,
  });
  return startQueuedRun(job, run.id);
}

/** A paused or blocked task still owns the role's activity slot. */
export function startQueuedRun(job: TaskExecutionState, id: string) {
  const run = job.ledger.run(id);
  if (
    run.status !== 'queued' ||
    !job.online ||
    job.updating ||
    job.controlling ||
    active(job.view.status) ||
    job.runtime.view().occupied
  )
    return;
  if (
    job.ledger.runs.some(
      (r) =>
        r.characterId === job.view.id &&
        r.status === 'queued' &&
        r.id !== run.id &&
        r.scheduledAt < run.scheduledAt,
    )
  )
    return;
  if (run.snapshot.limitsMode === 'inherit')
    run.snapshot.limits = {
      enabled: job.view.taskLimitsEnabled !== false,
      maxTurns: job.view.maxTurns,
      maxStalledTurns: job.view.maxStalledTurns ?? 3,
      tokenBudget: job.view.tokenBudget ?? 50000,
      taskTimeoutMs: job.view.taskTimeoutMs ?? 900000,
    };
  const started = job.runtime.startScheduled({
    goal: run.snapshot.goal,
    runId: run.id,
    planId: run.planId!,
    characterId: job.view.id,
    at: run.scheduledAt,
    eventId: run.eventId,
  });
  run.task = started.task;
  run.runtime = started.runtime;
  run.startedAt = started.task.startedAt;
  run.status = 'running';
  run.reason = '';
  job.currentRunId = run.id;
  job.view.status = 'idle';
  return run.id;
}

export async function executeTaskPlanControl(
  job: TaskExecutionState,
  planId: string,
  operation: string,
  value: unknown,
  save: () => Promise<void>,
  schedule: (job: TaskExecutionState) => void,
  launch: (job: TaskExecutionState) => void,
) {
  const plan = job.ledger.plans.find((p) => p.id === planId);
  if (!plan) throw new AppError('任务不存在。', 404);
  if (plan.state === 'archived') throw new AppError('任务已归档。');
  job.ledger.assertBinding(planId, job.view.id);
  if (operation === 'run') {
    const requestId = object(value).requestId;
    if (
      typeof requestId !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(requestId)
    )
      throw new AppError('执行请求标识无效。');
    const prior = job.ledger.runs.find(
      (r) => r.planId === planId && r.requestId === requestId,
    );
    if (prior) return runView(prior);
    if (job.ledger.unfinished(planId))
      throw new AppError('请先结束该计划的未完成执行。', 409);
    if (!job.online) throw new AppError('角色离线，请先上线。', 409);
    if (hasPlanTokenLimit(plan) && plan.spentTokens >= plan.totalTokenBudget)
      throw new AppError('请先追加计划累计额度。');
    let runId: string | undefined;
    await commitExecution(
      job,
      () => {
        runId = reserveRun(job, plan, 'manual', Date.now());
        job.ledger.runs.at(-1)!.requestId = requestId;
      },
      save,
      schedule,
      true,
    );
    if (runId) launch(job);
    return runView(
      job.ledger.runs.find(
        (r) => r.planId === planId && r.requestId === requestId,
      )!,
    );
  }
  return commitExecution(
    job,
    () => {
      return job.ledger.control(planId, operation, value);
    },
    save,
    schedule,
  );
}

export async function executeTaskRunControl(
  job: TaskExecutionState,
  runId: string,
  operation: string,
  value: unknown,
  validate: (settings: Partial<AICharacterSettings>) => AICharacterSettings,
  save: () => Promise<void>,
  schedule: (job: TaskExecutionState) => void,
  launch: (job: TaskExecutionState) => void,
  controlCurrentTask: (op: 'pause' | 'cancel') => Promise<TaskRun>,
) {
  captureTask(job);
  const run = job.ledger.runs.find((r) => r.id === runId);
  if (run?.characterId === job.view.id && run.status === 'queued') {
    if (operation !== 'cancel')
      throw new AppError('排队项只能取消，不能提前启动。', 409);
    return commitExecution(
      job,
      () => {
        run.status = 'cancelled';
        run.reason = '待执行项已取消。';
        job.runtime.recordRunControl({
          runId: run.id,
          characterId: job.view.id,
          operation: 'cancel',
          queued: true,
        });
        run.finishedAt = Date.now();
        const plan = job.ledger.plans.find((p) => p.id === run.planId);
        if (plan && syncPlanStateFromRun(plan, run)) job.ledger.touch(plan);
        return runView(run);
      },
      save,
      schedule,
    );
  }
  if (
    !run ||
    run.characterId !== job.view.id ||
    !run.runtime ||
    !runtimeView(run.runtime).task
  )
    throw new AppError('执行记录不存在或不可继续。', 404);
  if (endedRun(run)) throw new AppError('执行已结束，请重新执行任务。');
  if (operation === 'pause' || operation === 'cancel') {
    if (job.currentRunId === runId) return controlCurrentTask(operation);
    return commitExecution(
      job,
      () => {
        const runtime = createAgentRuntime({ state: run.runtime! });
        run.task = runtime.stageControl(
          { type: operation },
          { kind: 'operator' },
          { ...job.view, apiKey: '' },
          '已由玩家' + (operation === 'cancel' ? '结束。' : '暂停。'),
        );
        run.runtime = runtime.executionSnapshot();
        run.status = run.task.status;
        run.reason = run.task.reason;
        if (operation === 'cancel') run.finishedAt = Date.now();
        return runView(run);
      },
      save,
      schedule,
    );
  }
  if (operation !== 'resume') throw new AppError('执行操作无效。');
  if (!job.online || taskBusy(job))
    throw new AppError('角色离线或忙碌，请先上线或暂停当前执行。', 409);
  if (job.currentRunId !== runId && job.runtime.view().occupied)
    throw new AppError('请先结束当前执行，再恢复历史执行。', 409);
  if (runtimeView(run.runtime).requiresReassignment)
    throw new AppError('原私聊会话已失效，请重新通过聊天发起。', 409);
  const plan = job.ledger.plans.find((p) => p.id === run.planId);
  if (
    plan &&
    hasPlanTokenLimit(run.snapshot) &&
    plan.spentTokens >= plan.totalTokenBudget
  )
    throw new AppError('请先追加计划累计额度。');
  const enabled = run.snapshot.limits.enabled !== false;
  const settings = validate({
    ...run.snapshot.limits,
    ...taskLimits(object(value)),
  });
  if (
    enabled &&
    (settings.maxTurns <= run.task!.calls ||
      settings.tokenBudget! <= run.task!.tokens ||
      settings.taskTimeoutMs! <= run.task!.elapsedMs)
  )
    throw new AppError('继续执行的额度必须大于已使用额度。');
  await commitExecution(
    job,
    () => {
      captureTask(job);
      run.snapshot.limits = {
        enabled,
        maxTurns: settings.maxTurns,
        maxStalledTurns: settings.maxStalledTurns ?? 3,
        tokenBudget: settings.tokenBudget!,
        taskTimeoutMs: settings.taskTimeoutMs!,
      };
      job.runtime.resumeExecution(run.runtime!, {
        ...settings,
        ...(!enabled
          ? {
              maxTurns: Infinity,
              maxStalledTurns: Infinity,
              tokenBudget: Infinity,
              taskTimeoutMs: Infinity,
            }
          : {}),
        apiKey: '',
      });
      job.currentRunId = run.id;
      job.runtime.recordRunControl({
        runId: run.id,
        characterId: job.view.id,
        operation: 'resume',
      });

      run.status = 'running';
      job.view.status = 'idle';
      delete run.finishedAt;
    },
    save,
    schedule,
    true,
  );
  launch(job);
  return runView(run);
}

/** The runtime adapter supplies effects; all task-specific quota shaping lives here. */
export function executionConfigOverrides(state: TaskExecutionState) {
  const run = currentRun(state),
    plan = state.ledger.plans.find((p) => p.id === run?.planId);
  const limits = run?.snapshot.limits;
  return {
    ...(limits ? executionLimits(limits) : {}),
    ...(run && plan && hasPlanTokenLimit(run.snapshot)
      ? {
          tokenBudget: Math.min(
            executionLimits(limits!).tokenBudget,
            (state.runtime.view().task?.tokens ?? 0) +
              Math.max(0, plan.totalTokenBudget - plan.spentTokens),
          ),
        }
      : {}),
  };
}

/** Called only after the host has quiesced the runner or while updating its profile. */
export function pauseTaskForHost(state: TaskExecutionState, reason: string) {
  state.runtime.pauseForHost({ ...state.view, apiKey: '' }, reason);
}

/** Chat execution has no planId, but obeys the same durable history and occupied-slot rules. */
export async function beginChatExecution(
  state: TaskExecutionState,
  previousMemory: RuntimeState,
  config: AgentConfig,
  save: () => Promise<void>,
) {
  captureTask(state, createAgentRuntime({ state: previousMemory }));
  const previous = currentRun(state);
  if (previous && ['running', 'waiting'].includes(previous.status))
    throw new AgentRuntimeError('角色已有正在执行的任务，请先暂停或结束。');
  const beforeMemory = state.runtime.snapshot(),
    beforeRunId = state.currentRunId;
  try {
    state.currentRunId = undefined;
    captureTask(state);
    const limitsEnabled = state.view.taskLimitsEnabled !== false;
    Object.assign(config, {
      maxTurns: limitsEnabled ? state.view.maxTurns : Infinity,
      maxStalledTurns: limitsEnabled
        ? (state.view.maxStalledTurns ?? 3)
        : Infinity,
      tokenBudget: limitsEnabled ? (state.view.tokenBudget ?? 50000) : Infinity,
      taskTimeoutMs: limitsEnabled
        ? (state.view.taskTimeoutMs ?? 900000)
        : Infinity,
    });
    await save();
  } catch (error) {
    const failed = state.currentRunId;
    state.ledger.runs = state.ledger.runs.filter((r) => r.id !== failed);
    state.currentRunId = beforeRunId;
    state.runtime.rollback(beforeMemory);
    throw error;
  }
}

export function markJoined(state: TaskExecutionState) {
  state.runtime.joined();
}

export function markOffline(state: TaskExecutionState) {
  state.runtime.offline({ ...state.view, apiKey: '' });
}

export function modelChanged(state: TaskExecutionState) {
  state.runtime.modelChanged({ ...state.view, apiKey: '' });
}
