import { resolvePermissions, type AICharacterPermissions } from '@voxel/shared';
import {
  inBounds,
  parseChatRoute,
  LIMIT,
  MAX_Y,
  type Material,
} from '@voxel/shared';
import type { AgentAction } from '../../contracts';
import { parseBuildAction } from './build';

/** Model output is data: only these actions and bounded arguments can execute. */
export function parseAction(
  value: unknown,
  permissions: AICharacterPermissions,
): AgentAction {
  const fail = () => {
    throw Error('模型动作无效或不在允许范围内。');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail();
  const a = value as Record<string, unknown>;
  switch (a.type) {
    case 'goto':
      if (!resolvePermissions(permissions).move)
        throw Error('移动权限未开启。');
      if (
        ![a.x, a.y, a.z].every(
          (v) => typeof v === 'number' && Number.isFinite(v),
        ) ||
        Math.abs(Number(a.x)) > LIMIT - 0.3 ||
        Math.abs(Number(a.z)) > LIMIT - 0.3 ||
        Number(a.y) < 0.5 ||
        Number(a.y) > MAX_Y + 0.6
      )
        return fail();
      return { type: 'goto', x: Number(a.x), y: Number(a.y), z: Number(a.z) };
    case 'follow':
      if (!resolvePermissions(permissions).move)
        throw Error('移动权限未开启。');
      if (
        typeof a.playerId !== 'string' ||
        !a.playerId.trim() ||
        a.playerId.length > 128 ||
        typeof a.distance !== 'number' ||
        !Number.isFinite(a.distance) ||
        a.distance < 0.8 ||
        a.distance > 4
      )
        return fail();
      return { type: 'follow', playerId: a.playerId, distance: a.distance };
    case 'build':
    case 'house':
      return parseBuildAction(a, permissions);
    case 'wait':
      return { type: 'wait' };
    case 'chat':
      if (!resolvePermissions(permissions).chat)
        throw Error('发送聊天权限未开启。');
      if (typeof a.text !== 'string' || !a.text.trim() || a.text.length > 240)
        return fail();
      if (a.scope === undefined && a.recipients === undefined)
        return { type: 'chat', text: a.text.trim() };
      return { type: 'chat', text: a.text.trim(), ...parseChatRoute(a) };
    case 'move':
      if (!resolvePermissions(permissions).move)
        throw Error('移动权限未开启。');
      if (
        typeof a.x !== 'number' ||
        !Number.isFinite(a.x) ||
        Math.abs(a.x) > 1 ||
        typeof a.z !== 'number' ||
        !Number.isFinite(a.z) ||
        Math.abs(a.z) > 1 ||
        typeof a.jump !== 'boolean' ||
        !Number.isInteger(a.durationMs) ||
        Number(a.durationMs) < 100 ||
        Number(a.durationMs) > 1500
      )
        return fail();
      return {
        type: 'move',
        x: a.x,
        z: a.z,
        jump: a.jump,
        durationMs: Number(a.durationMs),
      };
    case 'edit': {
      if (
        !resolvePermissions(permissions)[
          a.material === null ? 'remove' : 'place'
        ]
      )
        throw Error('方块修改未开启：缺少放置或拆除权限。');
      const position = { x: a.x as number, y: a.y as number, z: a.z as number };
      if (
        !inBounds(position) ||
        position.y === 0 ||
        (a.material !== null &&
          (typeof a.material !== 'string' ||
            !['grass', 'dirt', 'stone', 'wood'].includes(a.material)))
      )
        return fail();
      return {
        type: 'edit',
        ...position,
        material: a.material as Material | null,
      };
    }
    default:
      return fail();
  }
}

export const MAX_ACTIONS = 8;

export function parseActions(
  value: unknown,
  permissions: AICharacterPermissions,
): AgentAction[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACTIONS)
    throw Error(`动作序列须包含 1–${MAX_ACTIONS} 个动作。`);
  const actions = value.map((action) => parseAction(action, permissions));
  if (actions.slice(0, -1).some((a) => a.type === 'wait'))
    throw Error('wait 只能出现在序列末尾。');
  if (
    actions.filter((a) => a.type === 'build' || a.type === 'house').length > 1
  )
    throw Error('每批最多一个 build 或 house。');
  return actions;
}
