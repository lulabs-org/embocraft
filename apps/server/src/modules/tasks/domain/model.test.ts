import { expect, it } from 'vitest';

import { duePlans, newPlan } from './model';

import { DEFAULT_TASK_LIMITS, type TaskTiming } from '@voxel/shared';

const draft = (timing: TaskTiming, timeZone = 'Asia/Shanghai') => ({
  name: '巡查',
  goal: '巡查后结束',
  timing,
  timeZone,
  limits: DEFAULT_TASK_LIMITS,
  totalTokenBudget: 500000,
});

it('sorts due plans by trigger then insertion order for equal creation times', () => {
  const a = newPlan(draft({ kind: 'once', at: 20 }), 1),
    b = newPlan(draft({ kind: 'once', at: 20 }), 1),
    c = newPlan(draft({ kind: 'once', at: 10 }), 2);
  expect(duePlans({ plans: [a, b, c] }, 20).map((p) => p.id)).toEqual([
    c.id,
    a.id,
    b.id,
  ]);
});
