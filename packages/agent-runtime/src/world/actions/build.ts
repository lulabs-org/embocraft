import {
  resolvePermissions,
  type AICharacterPermissions,
  type Material,
} from '@voxel/shared';
import { inBounds, key } from '@voxel/shared';
import { setTimeout as pause } from 'node:timers/promises';
import type {
  Observation,
  PlannedEdit,
  BuildAction,
  BuildResult,
} from '../../contracts';
import type { AgentSession } from '../../world/session/port';
import { observedEmpty } from '../observe/verify';

const BUILD_STEP_MS = 125;
const MAX_BATCH_BLOCKS = 64;
const MATERIALS: ReadonlySet<string> = new Set<Material>([
  'grass',
  'dirt',
  'stone',
  'wood',
]);
const DOORS: ReadonlySet<string> = new Set(['north', 'south', 'east', 'west']);
const RETRYABLE_FAILURES: ReadonlySet<string> = new Set([
  'out-of-reach',
  'occupied',
  'player-occupied',
  'unsupported',
  'empty',
]);

// ─── helpers ───────────────────────────────────────────────

function assertIntInRange(
  value: unknown,
  lo: number,
  hi: number,
  msg: string,
): void {
  if (!Number.isInteger(value) || Number(value) < lo || Number(value) > hi)
    throw Error(msg);
}

function parsePlannedEdit(value: unknown): PlannedEdit {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('方块参数无效。');
  const a = value as PlannedEdit;
  if (
    !inBounds(a) ||
    a.y === 0 ||
    (a.material !== null && !MATERIALS.has(a.material))
  )
    throw Error('方块参数无效。');
  return { x: a.x, y: a.y, z: a.z, material: a.material };
}

type HouseAction = Extract<BuildAction, { type: 'house' }>;

export function parseBuildAction(
  a: Record<string, unknown>,
  permissions: AICharacterPermissions,
): BuildAction {
  const capabilities = resolvePermissions(permissions);

  if (a.type === 'build') {
    if (
      !Array.isArray(a.blocks) ||
      !a.blocks.length ||
      a.blocks.length > MAX_BATCH_BLOCKS
    )
      throw Error(`批量建造需包含 1–${MAX_BATCH_BLOCKS} 个方块。`);
    const blocks = a.blocks.map(parsePlannedEdit);
    if (
      blocks.some(
        (b) => !capabilities[b.material === null ? 'remove' : 'place'],
      )
    )
      throw Error('方块修改未开启：批次缺少放置或拆除权限。');
    if (new Set(blocks.map(key)).size !== blocks.length)
      throw Error('同一批次不能重复修改同一位置。');
    return { type: 'build', blocks };
  }

  // house
  if (!capabilities.place) throw Error('方块修改未开启：缺少放置权限。');
  const origin = parsePlannedEdit(a);
  const sizeMsg = '房屋尺寸或门的方向无效。';
  if (a.type !== 'house' || origin.material === null) throw Error(sizeMsg);
  assertIntInRange(a.width, 3, 7, sizeMsg);
  assertIntInRange(a.depth, 3, 7, sizeMsg);
  assertIntInRange(a.height, 4, 6, sizeMsg);
  if (!DOORS.has(String(a.door ?? 'south'))) throw Error(sizeMsg);

  const house: HouseAction = {
    type: 'house',
    ...origin,
    material: origin.material,
    width: Number(a.width),
    depth: Number(a.depth),
    height: Number(a.height),
    door: String(a.door ?? 'south') as HouseAction['door'],
  };
  houseBlocks(house).forEach(parsePlannedEdit);
  return house;
}

function isDoorway(a: HouseAction, x: number, y: number, z: number): boolean {
  if (y !== 1 && y !== 2) return false;
  const midX = Math.floor(a.width / 2);
  const midZ = Math.floor(a.depth / 2);
  switch (a.door) {
    case 'north':
      return z === 0 && x === midX;
    case 'south':
      return z === a.depth - 1 && x === midX;
    case 'west':
      return x === 0 && z === midZ;
    case 'east':
      return x === a.width - 1 && z === midZ;
  }
}

/** Compact blueprint: foundation, hollow walls, two-block doorway, flat roof. */
export function houseBlocks(a: HouseAction): PlannedEdit[] {
  const blocks: PlannedEdit[] = [];
  for (let y = 0; y < a.height; y++)
    for (let z = 0; z < a.depth; z++)
      for (let x = 0; x < a.width; x++) {
        const slab = y === 0 || y === a.height - 1;
        const wall =
          x === 0 || x === a.width - 1 || z === 0 || z === a.depth - 1;
        if (slab || (wall && !isDoorway(a, x, y, z)))
          blocks.push({
            x: a.x + x,
            y: a.y + y,
            z: a.z + z,
            material: a.material,
          });
      }
  return blocks;
}

/** One inference drives many individually acknowledged, rate-bounded edits. */
export async function executeBuild(
  session: Pick<AgentSession, 'request'>,
  action: BuildAction,
  signal: AbortSignal,
  progress: (message: string) => void = () => {},
  checkpoint: (result: BuildResult) => void | Promise<void> = () => {},
): Promise<BuildResult> {
  const blocks = action.type === 'house' ? houseBlocks(action) : action.blocks;
  let observation = await session.request<Observation>('observe');
  let revision = observation.revision;
  let known = new Map(observation.blocks.map((b) => [key(b), b.material]));

  const result: BuildResult = {
    ok: false,
    total: blocks.length,
    completed: 0,
    skipped: 0,
    remaining: [...blocks],
    failures: [],
    note: '',
  };
  const save = () => checkpoint(structuredClone(result));
  const resolve = async (block: PlannedEdit) => {
    result.remaining = result.remaining.filter((b) => key(b) !== key(block));
    await save();
  };
  await save();

  // Pre-flight: reject house if interior is occupied.
  if (action.type === 'house') {
    const shell = new Set(blocks.map(key));
    const { x: ox, y: oy, z: oz, width: w, height: h, depth: d } = action;
    const obstruction = observation.blocks.find(
      (b) =>
        b.x >= ox &&
        b.x < ox + w &&
        b.y >= oy &&
        b.y < oy + h &&
        b.z >= oz &&
        b.z < oz + d &&
        !shell.has(key(b)),
    );
    if (obstruction) {
      result.remaining = blocks;
      result.failures = [
        {
          block: { ...obstruction, material: null },
          error: 'interior-occupied',
        },
      ];
      result.note =
        '房屋内部或门洞已有方块，尚未开始施工；请选择空地或明确规划清理，不会自动拆除已有地形。';
      await save();
      progress(result.note);
      return result;
    }
  }

  progress(`开始连续建造 · ${blocks.length} 个方块 · 无需逐块推理`);

  /** Attempt a single block edit; returns 'ok', 'skipped', or a failure string. */
  async function attemptBlock(
    block: PlannedEdit,
  ): Promise<'ok' | 'skipped' | string> {
    const bk = key(block);
    if (
      (block.material !== null && known.get(bk) === block.material) ||
      (block.material === null &&
        !known.has(bk) &&
        observedEmpty(observation, block))
    )
      return 'skipped';

    let failure: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      result.uncertain = [block];
      await save();
      const reply = await session.request('edit', { ...block, revision });
      result.uncertain = [];
      await save();
      revision = reply.revision;

      if (reply.ok) {
        if (block.material === null) known.delete(bk);
        else known.set(bk, block.material);
        return 'ok';
      }

      failure = reply.error ?? 'unknown';
      if ((failure === 'conflict' || failure === 'occupied') && attempt === 0) {
        observation = await session.request<Observation>('observe');
        revision = observation.revision;
        known = new Map(observation.blocks.map((b) => [key(b), b.material]));
        if (block.material !== null && known.get(bk) === block.material)
          return 'skipped';
        if (failure === 'occupied') break;
        await pause(BUILD_STEP_MS, undefined, { signal });
      } else break;
    }
    return failure ?? 'unknown';
  }

  for (let i = 0; i < blocks.length; i++) {
    signal.throwIfAborted();
    const block = blocks[i]!;
    if (i > 0) await pause(BUILD_STEP_MS, undefined, { signal });

    const outcome = await attemptBlock(block);
    if (outcome === 'skipped') {
      result.skipped++;
      await resolve(block);
    } else if (outcome === 'ok') {
      result.completed++;
      await resolve(block);
    } else {
      result.failures.push({ block, error: outcome });
      await save();
      if (!RETRYABLE_FAILURES.has(outcome)) break;
    }
    if ((i + 1) % 8 === 0)
      progress(
        `建造进度 · 新建/移除 ${result.completed} · 已存在 ${result.skipped} · 待处理 ${result.remaining.length}`,
      );
  }

  result.ok = result.remaining.length === 0;
  result.note = `建造${result.ok ? '完成' : '未完成'}：${result.completed} 个已修改，${result.skipped} 个已存在，${result.remaining.length} 个待处理。`;
  if (!result.ok)
    result.note += '根据失败原因调整位置/蓝图后重试；不要宣称房屋已完成。';
  await save();
  progress(result.note);
  return result;
}
