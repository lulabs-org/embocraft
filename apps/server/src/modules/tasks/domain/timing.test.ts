import { describe, expect, it } from 'vitest';

import { newPlan } from './model';

import { nextOccurrence } from './timing';

import {
  wallClockInstant,
  DEFAULT_TASK_LIMITS,
  type TaskTiming,
} from '@voxel/shared';

const at = (s: string) => Date.parse(s);

const draft = (timing: TaskTiming, timeZone = 'Asia/Shanghai') => ({
  name: '巡查',
  goal: '巡查后结束',
  timing,
  timeZone,
  limits: DEFAULT_TASK_LIMITS,
  totalTokenBudget: 500000,
});

describe('task calendar, UTC instants and exclusive next occurrence', () => {
  it('immediate has no timer; once only has a future occurrence', () => {
    expect(
      nextOccurrence(newPlan(draft({ kind: 'immediate' }), 1000), 1000),
    ).toBeUndefined();
    const p = newPlan(draft({ kind: 'once', at: 2000 }), 1000);
    expect(nextOccurrence(p, 1999)).toBe(2000);
    expect(nextOccurrence(p, 2000)).toBeUndefined();
  });

  it('anchors intervals at creation and resumes strictly in the future', () => {
    const p = newPlan(draft({ kind: 'interval', everyMs: 60000 }), 1000);
    expect(p.nextRunAt).toBe(61000);
    expect(nextOccurrence(p, 61000)).toBe(121000);
    expect(nextOccurrence(p, 3 * 60000 + 5000)).toBe(241000);
  });

  it('computes daily and weekly in their saved timezone', () => {
    const now = at('2026-10-18T02:00:00Z');
    expect(
      newPlan(draft({ kind: 'daily', time: '09:00' }), now).nextRunAt,
    ).toBe(at('2026-10-19T01:00:00Z'));
    expect(
      newPlan(draft({ kind: 'weekly', time: '09:00', weekdays: [2, 4] }), now)
        .nextRunAt,
    ).toBe(at('2026-10-20T01:00:00Z'));
  });

  it('skips nonexistent DST time and only triggers the first repeated time', () => {
    expect(
      wallClockInstant('2026-03-08', '02:30', 'America/New_York'),
    ).toBeUndefined();
    expect(
      newPlan(
        draft({ kind: 'daily', time: '02:30' }, 'America/New_York'),
        at('2026-03-08T00:00:00Z'),
      ).nextRunAt,
    ).toBe(at('2026-03-09T06:30:00Z'));
    expect(wallClockInstant('2026-11-01', '01:30', 'America/New_York')).toBe(
      at('2026-11-01T05:30:00Z'),
    );
    expect(
      newPlan(
        draft({ kind: 'daily', time: '01:30' }, 'America/New_York'),
        at('2026-11-01T05:30:00Z'),
      ).nextRunAt,
    ).toBe(at('2026-11-02T06:30:00Z'));
  });

  it('handles half-hour DST transitions', () => {
    expect(
      wallClockInstant('2026-10-04', '02:15', 'Australia/Lord_Howe'),
    ).toBeUndefined();
    expect(wallClockInstant('2026-04-05', '01:45', 'Australia/Lord_Howe')).toBe(
      at('2026-04-04T14:45:00Z'),
    );
  });
});
