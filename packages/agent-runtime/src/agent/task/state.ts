import type { AICharacterTask } from '@voxel/shared';
import type { BatchResult } from '../../contracts/action';

export function newTask(
  goal: string,
  owner?: string,
  privateTo?: string,
): AICharacterTask {
  return {
    goal,
    owner,
    privateTo,
    status: 'running',
    summary: '任务已接收，等待执行。',
    reason: '',
    calls: 0,
    tokens: 0,
    estimated: false,
    startedAt: Date.now(),
    elapsedMs: 0,
  };
}

/** A task the runtime may still advance without an operator command. */
export function isActiveTask(task?: AICharacterTask): task is AICharacterTask {
  return !!task && (task.status === 'running' || task.status === 'waiting');
}

/** A task that can never make progress again on its own. */
export function isEndedTask(task?: AICharacterTask): boolean {
  return !task || task.status === 'completed' || task.status === 'cancelled';
}

/** Restore batch history only; in-flight effects remain unknown and never replay automatically. */
export function restoreBatchHistory(value: unknown): BatchResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as BatchResult;
  if (
    !Array.isArray(candidate.actions) ||
    !Array.isArray(candidate.results) ||
    !Array.isArray(candidate.remaining)
  )
    return undefined;
  const batch = structuredClone(candidate);
  for (const result of batch.results) {
    if (result.status === 'executing') result.status = 'unknown';
  }
  if (batch.stopReason === 'executing') {
    batch.ok = false;
    batch.stopReason = 'unknown';
  }
  return batch;
}
