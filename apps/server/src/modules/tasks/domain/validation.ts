import { AppError } from '../../../core/errors/app-error';
import {
  DEFAULT_TASK_LIMITS,
  type TaskPlan,
  type TaskPlanDraft,
  type TaskTiming,
} from '@voxel/shared';

function integerRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = value ?? fallback;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new AppError(`数值须在 ${min}–${max} 之间。`);
  }
  return n;
}

/**
 * 校验并生成标准化的任务计划草稿
 */
export function validatePlan(
  value: unknown,
  now = Date.now(),
  previous?: TaskPlan,
): TaskPlanDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('任务格式无效。');
  }
  const v = { ...previous, ...value } as TaskPlanDraft;
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80) {
    throw new AppError('请填写 80 字以内的任务名称。');
  }
  if (typeof v.goal !== 'string' || !v.goal.trim() || v.goal.length > 2000) {
    throw new AppError('请填写 2000 字以内的任务目标。');
  }
  if (typeof v.timeZone !== 'string' || v.timeZone.length > 100) {
    throw new AppError('请选择有效时区。');
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: v.timeZone }).format();
  } catch {
    throw new AppError('请选择有效时区。');
  }

  const t = v.timing;
  if (!t || typeof t !== 'object') throw new AppError('执行方式无效。');
  let timing: TaskTiming;
  switch (t.kind) {
    case 'immediate':
      timing = { kind: t.kind };
      break;
    case 'once':
      integerRange(t.at, 0, 1, 8640000000000000);
      if (
        t.at <= now &&
        (previous?.timing.kind !== 'once' || previous.timing.at !== t.at)
      ) {
        throw new AppError('执行时间必须在将来。');
      }
      timing = { kind: t.kind, at: t.at };
      break;
    case 'interval':
      timing = {
        kind: t.kind,
        everyMs: integerRange(t.everyMs, 60000, 60000, 31 * 86400000),
      };
      break;
    case 'daily':
    case 'weekly':
      if (
        typeof t.time !== 'string' ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time)
      ) {
        throw new AppError('时间格式应为 HH:mm。');
      }
      if (t.kind === 'weekly') {
        if (
          !Array.isArray(t.weekdays) ||
          !t.weekdays.length ||
          t.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
        ) {
          throw new AppError('请选择星期。');
        }
        timing = {
          kind: t.kind,
          time: t.time,
          weekdays: [...new Set(t.weekdays)].sort(),
        };
      } else {
        timing = { kind: t.kind, time: t.time };
      }
      break;
    default:
      throw new AppError('执行方式无效。');
  }

  if (
    v.limits?.enabled !== undefined &&
    typeof v.limits.enabled !== 'boolean'
  ) {
    throw new AppError('执行限制开关必须为布尔值。');
  }

  if (
    v.limitsMode !== undefined &&
    !['inherit', 'override'].includes(v.limitsMode)
  )
    throw new AppError('额度来源无效。');

  if (
    v.totalTokenBudgetEnabled !== undefined &&
    typeof v.totalTokenBudgetEnabled !== 'boolean'
  )
    throw new AppError('计划累计额度开关必须为布尔值。');
  const totalTokenBudgetEnabled =
    v.totalTokenBudgetEnabled ??
    (v.limitsMode === 'inherit' || v.limits?.enabled !== false);

  // Hidden fields do not prevent saving an unlimited task; retain valid values for later use.
  const quota = (
    value: unknown,
    fallback: number,
    min: number,
    max: number,
    enabled = v.limits?.enabled !== false,
  ) =>
    !enabled &&
    (typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < min ||
      value > max)
      ? fallback
      : integerRange(value, fallback, min, max);

  return {
    name: v.name.trim(),
    goal: v.goal.trim(),
    timing,
    timeZone: v.timeZone,
    limitsMode:
      v.limitsMode ?? (previous || 'limits' in value ? 'override' : 'inherit'),
    limits: {
      enabled: v.limitsMode === 'inherit' || v.limits?.enabled !== false,
      maxTurns: quota(
        v.limits?.maxTurns,
        DEFAULT_TASK_LIMITS.maxTurns,
        1,
        1000,
      ),
      maxStalledTurns: quota(v.limits?.maxStalledTurns, 3, 1, 1000),
      tokenBudget: quota(
        v.limits?.tokenBudget,
        DEFAULT_TASK_LIMITS.tokenBudget,
        1000,
        100000000,
      ),
      taskTimeoutMs: quota(
        v.limits?.taskTimeoutMs,
        DEFAULT_TASK_LIMITS.taskTimeoutMs,
        60000,
        21600000,
      ),
    },
    totalTokenBudgetEnabled,
    totalTokenBudget: quota(
      v.totalTokenBudget,
      500000,
      1000,
      1000000000,
      totalTokenBudgetEnabled,
    ),
  };
}

export function taskLimits(input: Record<string, unknown>) {
  return Object.fromEntries(
    ['maxTurns', 'maxStalledTurns', 'tokenBudget', 'taskTimeoutMs']
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );
}
