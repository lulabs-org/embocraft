import {
  isRepeating,
  DEFAULT_TASK_LIMITS,
  type AICharacterView,
} from '@voxel/shared';
import { emptyState, type AgentRunState } from '@voxel/agent-runtime';
import { AppError } from '../../../core/errors/app-error';
import { newPlan, newRun } from '../domain/model';
import type { TaskBook } from '../domain/types';
import type { TaskSnapshot } from './snapshots';

type LegacyTaskOwner = Pick<
  AICharacterView,
  | 'id'
  | 'name'
  | 'task'
  | 'taskLimitsEnabled'
  | 'maxTurns'
  | 'tokenBudget'
  | 'taskTimeoutMs'
> & {
  runtime?: AgentRunState;
  taskBook?: TaskBook;
  currentRunId?: string;
};

export function migrateCharacterTasks(
  a: LegacyTaskOwner,
  target: TaskSnapshot,
) {
  const book = a.taskBook;
  if (book) {
    if (
      book.version !== 1 ||
      !Array.isArray(book.plans) ||
      !Array.isArray(book.runs)
    )
      throw new AppError('任务存档格式无效。', 500);
    for (const p of book.plans) {
      const runs = book.runs.filter((r) => r.planId === p.id);
      const chatOnly =
        p.timing.kind === 'immediate' &&
        !Object.values(book.requests ?? {}).includes(p.id) &&
        runs.length > 0 &&
        runs.every((r) => r.source === 'chat');
      if (chatOnly) {
        for (const r of runs) delete r.planId;
      } else
        target.plans.push({
          ...migrateBinding(p),
          ...(p.latestRun ? { latestRun: migrateBinding(p.latestRun) } : {}),
          characterId: a.id,
          characterName: a.name,
          revision: p.revision ?? 1,
          imported:
            !isRepeating(p.timing) &&
            !runs.some((r) => ['manual', 'scheduled'].includes(r.source)),
        });
    }
    for (const r of book.runs)
      target.runs.push({
        ...migrateBinding(r),
        characterId: a.id,
        characterName: a.name,
        planRevision: r.planId ? (r.planRevision ?? 1) : undefined,
      });
    for (const [key, id] of Object.entries(book.requests ?? {}))
      target.requests[`${a.id}:${key}`] = id;
    a.currentRunId = book.currentRunId;
  }
  if (!book && (a.runtime?.task.current || a.task)) {
    const task = a.runtime?.task.current ?? a.task!;
    const p = {
      ...newPlan(
        {
          name: task.goal.slice(0, 80) || '历史导入',
          goal: task.goal,
          timing: { kind: 'immediate' },
          timeZone: 'UTC',
          limits: {
            ...DEFAULT_TASK_LIMITS,
            enabled: a.taskLimitsEnabled !== false,
            maxTurns: a.maxTurns ?? DEFAULT_TASK_LIMITS.maxTurns,
            tokenBudget: a.tokenBudget ?? DEFAULT_TASK_LIMITS.tokenBudget,
            taskTimeoutMs: a.taskTimeoutMs ?? DEFAULT_TASK_LIMITS.taskTimeoutMs,
          },
          totalTokenBudget: 500000,
        },
        task.startedAt,
      ),
      characterId: a.id,
      characterName: a.name,
      imported: true,
    };
    const r = newRun(p, task.startedAt, 'legacy');
    r.task = structuredClone(task);
    r.runtime = a.runtime
      ? structuredClone(a.runtime)
      : { ...emptyState(), task: { current: structuredClone(task) } };
    r.status = task.status;
    r.totalTokens = task.tokens;
    r.accountedTokens = task.tokens;
    p.spentTokens = task.tokens;
    target.plans.push(p);
    target.runs.push(r);
    a.currentRunId = r.id;
  }
}

/** Rename only ownership fields; runtime checkpoints and opaque request keys are untouched. */
export function migrateBinding<T extends object>(value: T) {
  const { agentId, agentName, ...rest } = structuredClone(value) as T & {
    agentId?: string;
    agentName?: string;
  };
  return {
    ...rest,
    ...(agentId === undefined ? {} : { characterId: agentId }),
    ...(agentName === undefined ? {} : { characterName: agentName }),
  };
}
