export type TaskTiming =
  | { kind: 'immediate' }
  | { kind: 'once'; at: number }
  | { kind: 'interval'; everyMs: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; weekdays: number[] };

/** Whether the timing schedules recurring runs. */
export function isRepeating(timing: TaskTiming) {
  return ['interval', 'daily', 'weekly'].includes(timing.kind);
}

export function zonedDateParts(ms: number, zone: string) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ms);
  const n = (key: string) => Number(p.find((x) => x.type === key)!.value);
  return [n('year'), n('month'), n('day'), n('hour'), n('minute'), n('second')];
}
/** Resolve a wall clock time, choosing the first fold and rejecting DST gaps. */
export function wallClockInstant(
  date: string,
  time: string,
  zone: string,
): number | undefined {
  const [y, m, d] = date.split('-').map(Number),
    [h, min] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, h, min);
  const candidates = new Set<number>();
  for (const delta of [-36, -24, -12, 0, 12, 24, 36]) {
    const probe = wall + delta * 3600000;
    const [py, pm, pd, ph, pmin, ps] = zonedDateParts(probe, zone);
    const offset = Date.UTC(py, pm - 1, pd, ph, pmin, ps) - probe;
    const instant = wall - offset;
    if (
      zonedDateParts(instant, zone).slice(0, 5).join() ===
      [y, m, d, h, min].join()
    )
      candidates.add(instant);
  }
  return [...candidates].sort((a, b) => a - b)[0];
}
