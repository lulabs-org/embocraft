import type { TaskRunAction } from '@voxel/shared';
import { i18n } from '../../../../i18n';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export function presentAction(entry: TaskRunAction) {
  let raw = entry.detail;
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(entry.detail);
    data = object(parsed);
    raw = JSON.stringify(parsed, null, 2);
  } catch {
    // Older records may contain plain text; keep it available for inspection.
  }
  const action = object(data.action);
  const result = object(data.result);
  const title =
    (
      {
        wait: i18n.t('console.actions.wait'),
        move: i18n.t('console.actions.move'),
        goto: i18n.t('console.actions.goto'),
        follow: i18n.t('console.actions.follow'),
        move_to: i18n.t('console.actions.moveTo'),
        chat: i18n.t('console.actions.chat'),
        edit:
          action.material === null
            ? i18n.t('console.actions.destroyBlock')
            : i18n.t('console.actions.placeBlock'),
        house: i18n.t('console.actions.buildHouse'),
        build: i18n.t('console.actions.batchBuild'),
        observe: i18n.t('console.actions.observe'),
      } as Record<string, string>
    )[entry.kind] ?? entry.kind;
  const parts: string[] = [];
  if (entry.kind === 'move') {
    const x = number(action.x),
      z = number(action.z),
      duration = number(action.durationMs);
    if (x !== undefined && z !== undefined) {
      const direction = [
        x ? `${x > 0 ? '+' : '−'}X` : '',
        z ? `${z > 0 ? '+' : '−'}Z` : '',
      ]
        .filter(Boolean)
        .join(' / ');
      parts.push(
        direction
          ? i18n.t('console.actions.direction', { dir: direction })
          : i18n.t('console.actions.stationary'),
      );
    }
    if (action.jump === true) parts.push(i18n.t('console.actions.jump'));
    if (duration !== undefined)
      parts.push(i18n.t('console.actions.seconds', { sec: duration / 1000 }));
  } else if (entry.kind === 'follow') {
    if (typeof action.playerId === 'string')
      parts.push(i18n.t('console.actions.target', { id: action.playerId }));
    if (number(action.distance) !== undefined)
      parts.push(
        i18n.t('console.actions.keepDistance', { dist: action.distance }),
      );
  } else if (['edit', 'house', 'move_to', 'goto'].includes(entry.kind)) {
    if ([action.x, action.y, action.z].every((v) => number(v) !== undefined))
      parts.push(
        i18n.t('console.actions.position', {
          x: action.x,
          y: action.y,
          z: action.z,
        }),
      );
    if (typeof action.material === 'string')
      parts.push(i18n.t('console.actions.material', { mat: action.material }));
  } else if (entry.kind === 'build' && Array.isArray(action.blocks)) {
    parts.push(
      i18n.t('console.actions.blockCount', { count: action.blocks.length }),
    );
  }
  const feedback = [result.error, result.note]
    .filter((v): v is string => typeof v === 'string' && !!v.trim())
    .join(' · ');
  const status =
    entry.status === 'succeeded' && entry.kind === 'follow'
      ? i18n.t('console.actions.statusFollowStarted')
      : entry.status === 'succeeded' &&
          entry.kind === 'goto' &&
          result.status === 'arrived'
        ? i18n.t('console.actions.statusArrived')
        : entry.status === 'succeeded' && entry.kind === 'move'
          ? i18n.t('console.actions.statusCommandSent')
          : ((
              {
                pending: i18n.t('console.actions.statusPending'),
                executing: i18n.t('console.actions.statusExecuting'),
                succeeded: i18n.t('console.actions.statusSucceeded'),
                failed: i18n.t('console.actions.statusFailed'),
                interrupted: i18n.t('console.actions.statusInterrupted'),
                unknown: i18n.t('console.actions.statusUnknown'),
              } as Record<string, string>
            )[entry.status] ?? entry.status);
  const tone =
    entry.status === 'succeeded'
      ? 'success'
      : entry.status === 'failed'
        ? 'error'
        : ['interrupted', 'unknown'].includes(entry.status)
          ? 'warning'
          : 'neutral';
  return { title, summary: parts.join(' · '), feedback, status, tone, raw };
}
