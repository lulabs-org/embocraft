import {
  inBounds,
  distance,
  REACH,
  key,
  overlaps,
  type Edit,
  type Vec3,
  type Block,
  type Input,
} from '@voxel/shared';
export function validateEdit(
  edit: Edit,
  actor: Vec3,
  players: Vec3[],
  blocks: Map<string, Block>,
  revision: number,
): string | null {
  if (!inBounds(edit) || edit.y === 0) return 'bounds';
  if (!Number.isInteger(edit.revision) || edit.revision !== revision)
    return 'conflict';
  if (distance({ ...actor, y: actor.y + 1.3 }, edit) > REACH)
    return 'out-of-reach';
  if (
    edit.material !== null &&
    !['grass', 'dirt', 'stone', 'wood'].includes(edit.material)
  )
    return 'material';
  if (edit.material === null) return blocks.has(key(edit)) ? null : 'empty';
  if (blocks.has(key(edit))) return 'occupied';
  if (players.some((p) => overlaps(p, edit))) return 'player-occupied';
  const adjacent = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ].some(([x, y, z]) =>
    blocks.has(key({ x: edit.x + x!, y: edit.y + y!, z: edit.z + z! })),
  );
  return adjacent ? null : 'unsupported';
}
export function parseInput(value: unknown): Input | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Input;
  if (
    ![v.x, v.z, v.yaw].every(
      (n) => typeof n === 'number' && Number.isFinite(n),
    ) ||
    Math.abs(v.x) > 1 ||
    Math.abs(v.z) > 1 ||
    Math.abs(v.yaw) > Math.PI * 4 ||
    typeof v.jump !== 'boolean'
  )
    return null;
  return { x: v.x, z: v.z, yaw: v.yaw, jump: v.jump };
}
