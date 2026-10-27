import { isRepeating, type TaskPlan, type TaskRun } from '@voxel/shared';
import { hasPlanTokenLimit, executionLimits } from '../domain/limits';
import {
  endedRun,
  newRun,
  runView,
  settleTaskUsage,
  syncPlanStateFromRun,
} from '../domain/model';
import {
  newTask,
  recordEvent,
  TaskService,
  AgentRuntimeError,
  type AgentRunState,
  type AgentConfig,
  emptyState,
  snapshotState,
} from '@voxel/agent-runtime';
import { object } from '../../../core/http/validation';
import { taskLimits } from '../domain/validation';
import { AppError } from '../../../core/errors/app-error';
import type { TaskExecutionState } from './execution-port';
import type { AICharacterSettings } from '@voxel/shared';
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

export function captureTask(job: TaskExecutionState) {
  for (const event of job.memory.inbox?.events ?? []) {
    if (event.kind !== 'plan' || event.state !== 'pending') continue;
    const run = job.ledger.runs.find((r) => r.id === event.runId);
    if (!run || endedRun(run)) {
      event.state = 'done';
      event.detail = run?.reason ?? '排队提交未完成。';
    }
  }
  if (!job.memory.task.current) return;
  new TaskService(job.memory).lease();
  let run = currentRun(job);
  if (
    !run ||
    (run.task && run.task.startedAt !== job.memory.task.current.startedAt)
  ) {
    const snapshot = {
      name: job.memory.task.current.goal.slice(0, 80) || '聊天执行',
      goal: job.memory.task.current.goal,
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
        createdAt: job.memory.task.current.startedAt,
        updatedAt: job.memory.task.current.startedAt,
        state: 'enabled',
        reason: '',
        spentTokens: 0,
      },
      job.memory.task.current.startedAt,
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
  const task = job.memory.task.current;
  settleTaskUsage(run!, task.tokens, plan);
  const batch = job.memory.effects.previous as
    | {
        batchId?: string;
        results?: {
          startedAt?: number;
          action?: { type?: string };
          status?: string;
          result?: unknown;
        }[];
      }
    | undefined;
  if (
    Array.isArray(batch?.results) &&
    JSON.stringify(batch) !== run.lastBatch
  ) {
    run.lastBatch = JSON.stringify(batch);
    const call = job.memory.task.usage?.calls ?? task.calls;
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
  run.runtime = snapshotState(job.memory);
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
  const memoryBeforeChange = job.memory;
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
    memory: structuredClone(job.memory),
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
    if (swapsExecution && job.memory !== memoryBeforeChange) {
      job.memory = before.memory;
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
  run.eventId = `plan:${plan.id}:${plan.revision ?? 1}:${at}`;
  recordEvent(job.memory, {
    id: run.eventId,
    kind: 'plan',
    state: 'pending',
    at,
    audience: 'public',
    characterId: job.view.id,
    planId: plan.id,
    runId: run.id,
    detail: run.snapshot.goal,
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
    (job.memory.task.current &&
      !['completed', 'cancelled'].includes(job.memory.task.current.status))
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
  const task = newTask(run.snapshot.goal);
  if (run.snapshot.limitsMode === 'inherit')
    run.snapshot.limits = {
      enabled: job.view.taskLimitsEnabled !== false,
      maxTurns: job.view.maxTurns,
      maxStalledTurns: job.view.maxStalledTurns ?? 3,
      tokenBudget: job.view.tokenBudget ?? 50000,
      taskTimeoutMs: job.view.taskTimeoutMs ?? 900000,
    };
  run.task = task;
  run.runtime = { ...emptyState(), task: { current: task } };
  run.startedAt = task.startedAt;
  run.status = 'running';
  run.reason = '';
  job.currentRunId = run.id;
  job.memory = {
    ...emptyState(),
    task: { current: task, usage: job.memory.task.usage },
    conversation: { exchanges: job.memory.conversation.exchanges },
    inbox: job.memory.inbox,
  };
  const lease = new TaskService(job.memory).lease();
  const event = recordEvent(job.memory, {
    id: run.eventId ?? `run:${run.id}`,
    kind: 'plan',
    state: 'pending',
    at: run.scheduledAt,
    audience: 'public',
    runId: run.id,
    detail: run.snapshot.goal,
  });
  Object.assign(event, {
    taskId: lease.id,
    revision: lease.revision,
    characterId: job.view.id,
    planId: run.planId,
  });
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
        recordEvent(job.memory, {
          id: `control:${run.id}:cancel`,
          kind: 'control',
          state: 'done',
          at: Date.now(),
          audience: 'public',
          characterId: job.view.id,
          runId: run.id,
          detail: '取消待执行项',
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
  if (!run || run.characterId !== job.view.id || !run.runtime?.task.current)
    throw new AppError('执行记录不存在或不可继续。', 404);
  if (endedRun(run)) throw new AppError('执行已结束，请重新执行任务。');
  if (operation === 'pause' || operation === 'cancel') {
    if (job.currentRunId === runId) return controlCurrentTask(operation);
    return commitExecution(
      job,
      () => {
        new TaskService(run.runtime!).command(
          { type: operation },
          { kind: 'operator' },
          { ...job.view, apiKey: '' },
        );
        run.runtime!.task.current!.reason =
          '已由玩家' + (operation === 'cancel' ? '结束。' : '暂停。');
        run.task = structuredClone(run.runtime!.task.current);
        run.status = run.task!.status;
        run.reason = run.task!.reason;
        if (operation === 'cancel') {
          run.finishedAt = Date.now();
          delete run.runtime!.effects.follow;
        }
        return runView(run);
      },
      save,
      schedule,
    );
  }
  if (operation !== 'resume') throw new AppError('执行操作无效。');
  if (!job.online || taskBusy(job))
    throw new AppError('角色离线或忙碌，请先上线或暂停当前执行。', 409);
  if (
    job.currentRunId !== runId &&
    job.memory.task.current &&
    !['completed', 'cancelled'].includes(job.memory.task.current.status)
  )
    throw new AppError('请先结束当前执行，再恢复历史执行。', 409);
  if (run.runtime.conversation.audienceExpired)
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
      job.memory = {
        ...structuredClone(run.runtime!),
        task: { ...run.runtime!.task, usage: job.memory.task.usage },
      };
      new TaskService(job.memory).command(
        { type: 'resume' },
        { kind: 'operator' },
        {
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
        },
      );
      job.currentRunId = run.id;
      const lease = new TaskService(job.memory).lease();
      recordEvent(job.memory, {
        id: `control:${run.id}:${lease.revision}:resume`,
        kind: 'control',
        state: 'pending',
        at: Date.now(),
        audience: job.memory.task.current?.privateTo ?? 'public',
        characterId: job.view.id,
        runId: run.id,
        taskId: lease.id,
        revision: lease.revision,
        detail: '人工继续执行，保留原进度和用量。',
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
            (state.memory.task.current?.tokens ?? 0) +
              Math.max(0, plan.totalTokenBudget - plan.spentTokens),
          ),
        }
      : {}),
  };
}

/** Called only after the host has quiesced the runner or while updating its profile. */
export function pauseTaskForHost(state: TaskExecutionState, reason: string) {
  const task = state.memory.task.current;
  if (task && !['completed', 'cancelled'].includes(task.status)) {
    new TaskService(state.memory).command(
      { type: 'pause' },
      { kind: 'operator' },
      { ...state.view, apiKey: '' },
    );
    task.reason = reason;
  }
}

/** Chat execution has no planId, but obeys the same durable history and occupied-slot rules. */
export async function beginChatExecution(
  state: TaskExecutionState,
  previousMemory: AgentRunState,
  config: AgentConfig,
  save: () => Promise<void>,
) {
  const nextMemory = state.memory;
  try {
    state.memory = previousMemory;
    captureTask(state);
  } finally {
    state.memory = nextMemory;
  }
  const previous = currentRun(state);
  if (previous && ['running', 'waiting'].includes(previous.status))
    throw new AgentRuntimeError('角色已有正在执行的任务，请先暂停或结束。');
  const beforeMemory = structuredClone(state.memory),
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
    for (const key of Object.keys(state.memory))
      delete (state.memory as Record<string, unknown>)[key];
    Object.assign(state.memory, beforeMemory);
    throw error;
  }
}

export function markJoined(state: TaskExecutionState) {
  const task = state.memory.task.current;
  if (task && ['running', 'waiting', 'paused'].includes(task.status)) {
    task.status = 'paused';
    task.reason = '已加入世界待命，任务进度保留。';
  }
}

export function markOffline(state: TaskExecutionState) {
  if (['running', 'waiting'].includes(state.memory.task.current?.status ?? ''))
    pauseTaskForHost(state, '角色已离开世界，任务进度已保留。');
}

export function modelChanged(state: TaskExecutionState) {
  pauseTaskForHost(state, '模型已修改，进度已保留，请确认后继续。');
  if (state.memory.checkpoint.pi?.inFlight)
    state.memory.checkpoint.unknownEffect = {
      ...state.memory.checkpoint.pi.inFlight,
      state: 'unknown',
    };
  delete state.memory.checkpoint.pi;
}
