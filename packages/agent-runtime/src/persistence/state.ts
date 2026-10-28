import { emptyState, type RuntimeState } from '../contracts/state';

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Load the current schema only. Unsupported archives must never become empty state. */
export function restoreState(raw: unknown): RuntimeState {
  if (raw === undefined) return emptyState();
  if (!isRecord(raw) || raw.version !== 4)
    throw new Error('运行时存档格式不受支持：只接受 version 4。');
  const { character, execution } = raw;
  if (
    !isRecord(character) ||
    !isRecord(character.conversation) ||
    !isRecord(execution) ||
    !['task', 'conversation', 'checkpoint', 'effects', 'health'].every((key) =>
      isRecord(execution[key]),
    )
  )
    throw new Error('运行时存档缺少有效的角色或任务执行分区。');
  const checkpoint = execution.checkpoint as Record_;
  if (
    checkpoint.pi !== undefined &&
    (!isRecord(checkpoint.pi) ||
      checkpoint.pi.version !== 3 ||
      typeof checkpoint.pi.taskId !== 'string' ||
      typeof checkpoint.pi.revision !== 'number')
  )
    throw new Error('运行时模型检查点格式不受支持。');
  return structuredClone(raw) as RuntimeState;
}
