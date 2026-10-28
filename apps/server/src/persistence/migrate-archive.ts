import { AppError } from '../core/errors/app-error';
import type { ManagementArchive } from './archive';

/** Validate and normalize a persisted v3 management archive before restoration. */
export function migrateArchive(saved: unknown): ManagementArchive {
  const candidate = saved as Partial<ManagementArchive> | null | undefined;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    candidate.version !== 3 ||
    !Array.isArray(candidate.characters) ||
    !Array.isArray(candidate.plans) ||
    !Array.isArray(candidate.runs) ||
    !candidate.requests ||
    typeof candidate.requests !== 'object' ||
    Array.isArray(candidate.requests)
  )
    throw new AppError('网关存档格式无效。', 500);
  if (candidate.characters.length > 50)
    throw new AppError('Agent 记录格式无效。', 500);
  const copy = structuredClone(candidate as ManagementArchive);
  for (const plan of copy.plans) plan.limitsMode ??= 'override';
  for (const run of copy.runs) run.snapshot.limitsMode ??= 'override';
  validateArchive(copy);
  return copy;
}

function validateArchive(s: ManagementArchive) {
  for (const list of [s.characters, s.plans, s.runs]) {
    const ids = list.map((x) => x.id);
    if (
      ids.some((id) => typeof id !== 'string' || !id) ||
      new Set(ids).size !== ids.length
    )
      throw new AppError('存档资源标识重复或无效。', 500);
  }
  for (const p of s.plans)
    if (p.characterId && !s.characters.some((a) => a.id === p.characterId))
      throw new AppError('计划关联角色不存在。', 500);
  for (const r of s.runs)
    if (r.planId && !s.plans.some((p) => p.id === r.planId))
      throw new AppError('执行关联计划不存在。', 500);
  for (const a of s.characters)
    if (
      a.currentRunId &&
      !s.runs.some((r) => r.id === a.currentRunId && r.characterId === a.id)
    )
      throw new AppError('当前执行关联无效。', 500);
}
