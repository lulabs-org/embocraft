import { AppError } from '../core/errors/app-error';
import type {
  CharacterRecord,
  ManagementArchive,
  LegacyAgentArchive,
} from './archive';
import {
  migrateBinding,
  migrateCharacterTasks,
} from '../modules/tasks/persistence/archive-migration';

/** Pure, repeatable migration; disk backup and atomic replacement belong to the host. */
export function migrateArchive(
  saved: CharacterRecord[] | LegacyAgentArchive | ManagementArchive,
): ManagementArchive {
  if (!Array.isArray(saved)) {
    if (
      !saved ||
      ![1, 2, 3].includes(saved.version) ||
      !Array.isArray(saved.version === 1 ? saved.agents : saved.characters) ||
      !Array.isArray(saved.plans) ||
      !Array.isArray(saved.runs) ||
      !saved.requests ||
      typeof saved.requests !== 'object'
    )
      throw new AppError('网关存档格式无效。', 500);
    const copy: ManagementArchive =
      saved.version === 1
        ? {
            version: 3,
            characters: structuredClone(saved.agents),
            plans: saved.plans.map((plan) => {
              const converted = migrateBinding(plan);
              if (converted.latestRun)
                converted.latestRun = migrateBinding(converted.latestRun);
              return converted;
            }),
            runs: saved.runs.map(migrateBinding),
            requests: structuredClone(saved.requests),
          }
        : structuredClone(saved);
    copy.version = 3;
    for (const plan of copy.plans) plan.limitsMode ??= 'override';
    for (const run of copy.runs) run.snapshot.limitsMode ??= 'override';
    validateArchive(copy);
    return copy;
  }
  const result: ManagementArchive = {
    version: 3,
    characters: [],
    plans: [],
    runs: [],
    requests: {},
  };
  for (const original of saved) {
    const a = structuredClone(original);
    migrateCharacterTasks(a, result);
    delete a.taskBook;
    result.characters.push(a);
  }
  for (const plan of result.plans) plan.limitsMode ??= 'override';
  for (const run of result.runs) run.snapshot.limitsMode ??= 'override';
  validateArchive(result);
  return result;
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
