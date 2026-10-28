import type { TaskPlan, TaskRun } from '@voxel/shared';
import { i18n } from '../../../../i18n';

export const runEnded = (run: TaskRun) =>
  ['completed', 'cancelled', 'skipped', 'missed'].includes(run.status);

const getRunStatusLabel = (status: TaskRun['status']) => {
  const map: Record<TaskRun['status'], string> = {
    queued: i18n.t('console.plans.statusQueued'),
    running: i18n.t('console.plans.statusRunning'),
    waiting: i18n.t('console.plans.statusWaiting'),
    paused: i18n.t('console.plans.statusRunPaused'),
    completed: i18n.t('console.plans.statusCompleted'),
    cancelled: i18n.t('console.plans.statusCancelled'),
    needs_input: i18n.t('console.plans.statusNeedsInput'),
    blocked: i18n.t('console.plans.statusBlocked'),
    budget: i18n.t('console.plans.statusBudget'),
    failed: i18n.t('console.plans.statusFailed'),
    missed: i18n.t('console.plans.statusMissed'),
    skipped: i18n.t('console.plans.statusSkipped'),
  };
  return map[status] || status;
};

export const runStatus: Record<TaskRun['status'], string> = new Proxy(
  {} as Record<TaskRun['status'], string>,
  {
    get(_target, prop: string) {
      return getRunStatusLabel(prop as TaskRun['status']);
    },
  },
);

const getPlanStatusLabel = (state: TaskPlan['state']) => {
  const map: Record<TaskPlan['state'], string> = {
    enabled: i18n.t('console.plans.statusEnabled'),
    paused: i18n.t('console.plans.planStatePaused'),
    completed: i18n.t('console.plans.planStateCompleted'),
    archived: i18n.t('console.plans.statusArchived'),
  };
  return map[state] || state;
};

export const planStatus: Record<TaskPlan['state'], string> = new Proxy(
  {} as Record<TaskPlan['state'], string>,
  {
    get(_target, prop: string) {
      return getPlanStatusLabel(prop as TaskPlan['state']);
    },
  },
);

export function planTime(at: number | undefined, zone: string) {
  return at
    ? new Intl.DateTimeFormat(i18n.language === 'en' ? 'en-US' : 'zh-CN', {
        timeZone: zone,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        year: 'numeric',
        hourCycle: 'h23',
      }).format(at)
    : '—';
}

export function timingLabel(plan: TaskPlan) {
  const t = plan.timing;
  switch (t.kind) {
    case 'immediate':
      return i18n.t('console.plans.immediate');
    case 'once':
      return i18n.t('console.plans.planTimingOnce', {
        time: planTime(t.at, plan.timeZone),
      });
    case 'interval': {
      const interval =
        t.everyMs % 3600000 === 0
          ? i18n.t('console.plans.hourUnit', { count: t.everyMs / 3600000 })
          : i18n.t('console.plans.minuteUnit', { count: t.everyMs / 60000 });
      return i18n.t('console.plans.planTimingInterval', { interval });
    }
    case 'daily':
      return i18n.t('console.plans.planTimingDaily', { time: t.time });
    case 'weekly': {
      const weekdaysList =
        i18n.language === 'en'
          ? i18n.t('console.plans.weekdays').split(',')
          : Array.from(i18n.t('console.plans.weekdays'));
      const sep = i18n.language === 'en' ? ', ' : '、';
      const days = t.weekdays.map((d) => weekdaysList[d] ?? d).join(sep);
      return i18n.t('console.plans.planTimingWeekly', {
        weekdays: days,
        time: t.time,
      });
    }
  }
}

export const timingIcon = (kind: TaskPlan['timing']['kind']) => {
  switch (kind) {
    case 'immediate':
      return '⚡';
    case 'once':
      return '⏱';
    case 'interval':
    case 'daily':
    case 'weekly':
      return '↻';
    default:
      return '📋';
  }
};
