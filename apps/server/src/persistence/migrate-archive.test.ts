import { expect, it } from 'vitest';
import { migrateArchive } from './migrate-archive';
import { newPlan, newRun } from '../modules/tasks';
import { DEFAULT_TASK_LIMITS } from '@voxel/shared';

const draft = {
  name: '巡查',
  goal: '观察',
  timing: { kind: 'immediate' as const },
  timeZone: 'UTC',
  limits: DEFAULT_TASK_LIMITS,
  totalTokenBudget: 500000,
};

it('validates v3 archives and fills missing limitsMode defaults without mutating input', () => {
  const plan = { ...newPlan(draft, 100), characterId: 'a', characterName: 'A' };
  delete (plan as { limitsMode?: string }).limitsMode;
  const run = newRun(plan, 101, 'manual');
  delete (run.snapshot as { limitsMode?: string }).limitsMode;
  const input = {
    version: 3 as const,
    characters: [{ id: 'a', name: 'A', currentRunId: run.id }],
    plans: [plan],
    runs: [run],
    requests: { 'a:req': plan.id },
  };
  const result = migrateArchive(input);
  expect(result.plans[0].limitsMode).toBe('override');
  expect(result.runs[0].snapshot.limitsMode).toBe('override');
  expect(plan.limitsMode).toBeUndefined();
  expect(migrateArchive(result)).toEqual(result);
});

it('rejects duplicate identities, dangling references and unsupported envelopes before execution', () => {
  expect(() =>
    migrateArchive({
      version: 3,
      characters: [{ id: 'same' }, { id: 'same' }],
      plans: [],
      runs: [],
      requests: {},
    }),
  ).toThrow('标识');
  expect(() =>
    migrateArchive({
      version: 2,
      characters: [],
      plans: [],
      runs: [],
      requests: {},
    }),
  ).toThrow('格式');
  expect(() => migrateArchive([{ id: 'a' }])).toThrow('格式');
  expect(() =>
    migrateArchive({
      version: 3,
      characters: [{ id: 'a', currentRunId: 'missing' }],
      plans: [],
      runs: [],
      requests: {},
    }),
  ).toThrow('当前执行');
  expect(() =>
    migrateArchive({
      version: 3,
      characters: [],
      plans: [{ id: 'p1', characterId: 'missing' }],
      runs: [],
      requests: {},
    }),
  ).toThrow('计划关联角色不存在');
});
