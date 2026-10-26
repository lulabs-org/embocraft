import { expect, it } from 'vitest';

import { validatePlan } from './validation';

import {
  DEFAULT_TASK_LIMITS,
  hasPlanTokenLimit,
  type TaskTiming,
} from '@voxel/shared';

const draft = (timing: TaskTiming, timeZone = 'Asia/Shanghai') => ({
  name: '巡查',
  goal: '巡查后结束',
  timing,
  timeZone,
  limits: DEFAULT_TASK_LIMITS,
  totalTokenBudget: 500000,
});

it('validates schedules, timezone and quotas without accepting model fields', () => {
  for (const patch of [
    { timeZone: 'Mars/Nowhere' },
    { timing: { kind: 'interval', everyMs: 0 } },
    { timing: { kind: 'weekly', weekdays: [], time: '09:00' } },
    { timing: { kind: 'daily', time: '25:00' } },
    { timing: { kind: 'once', at: 10 } },
    { limits: { maxTurns: 0 } },
    { totalTokenBudget: NaN },
  ])
    expect(() =>
      validatePlan({ ...draft({ kind: 'immediate' }), ...patch }, 100),
    ).toThrow();
  expect(
    validatePlan({
      ...draft({ kind: 'immediate' }),
      spentTokens: 0,
      state: 'enabled',
      permissions: { remove: true },
    }),
  ).not.toHaveProperty('permissions');
});

it('defaults old limits to enabled and persists an explicit unchecked setting', () => {
  expect(validatePlan(draft({ kind: 'immediate' })).limits.enabled).toBe(true);
  const input = {
    ...draft({ kind: 'immediate' }),
    limits: { ...DEFAULT_TASK_LIMITS, enabled: false },
  };
  expect(validatePlan(JSON.parse(JSON.stringify(input))).limits.enabled).toBe(
    false,
  );
  expect(() =>
    validatePlan({ ...input, limits: { ...input.limits, enabled: 'false' } }),
  ).toThrow('开关');
});

it('keeps legacy cumulative behavior while allowing an independent toggle', () => {
  const recurring = draft({ kind: 'interval', everyMs: 60000 });
  expect(hasPlanTokenLimit(recurring)).toBe(true);
  expect(
    hasPlanTokenLimit({
      ...recurring,
      limits: { ...DEFAULT_TASK_LIMITS, enabled: false },
    }),
  ).toBe(false);
  const disabled = validatePlan({
    ...recurring,
    totalTokenBudgetEnabled: false,
  });
  expect(disabled.totalTokenBudgetEnabled).toBe(false);
  expect(hasPlanTokenLimit(disabled)).toBe(false);
  const independent = validatePlan({
    ...recurring,
    limits: { ...DEFAULT_TASK_LIMITS, enabled: false },
    totalTokenBudgetEnabled: true,
  });
  expect(hasPlanTokenLimit(independent)).toBe(true);
  expect(() =>
    validatePlan({ ...recurring, totalTokenBudgetEnabled: 'false' }),
  ).toThrow('开关');
});

it('ignores invalid hidden quota fields only when limits are disabled', () => {
  const input = {
    ...draft({ kind: 'immediate' }),
    limits: { enabled: false, maxTurns: null, tokenBudget: -1 },
    totalTokenBudget: null,
  };
  expect(validatePlan(input)).toMatchObject({
    limits: { ...DEFAULT_TASK_LIMITS, enabled: false },
    totalTokenBudget: 500000,
  });
  expect(() =>
    validatePlan({ ...input, limits: { ...input.limits, enabled: true } }),
  ).toThrow();
  expect(
    validatePlan({
      ...draft({ kind: 'interval', everyMs: 60000 }),
      totalTokenBudgetEnabled: false,
      totalTokenBudget: NaN,
    }).totalTokenBudget,
  ).toBe(500000);
});
