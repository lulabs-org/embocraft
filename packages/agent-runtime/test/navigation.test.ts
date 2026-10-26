import { emptyState } from '@voxel/agent-runtime';
import { describe, it, expect, vi } from 'vitest';
import { findPath } from '../src/world/nav/astar';
import { collisionMap } from '../src/world/nav/map';
import { navigate } from '../src/world/nav/controller';
import { navigationWorld } from '../../../tests/support/navigation-world';
vi.mock('node:timers/promises', async (original) => ({
  ...(await original<typeof import('node:timers/promises')>()),
  setTimeout: (
    ms: number,
    value: unknown,
    options?: { signal?: AbortSignal },
  ) =>
    new Promise((resolve, reject) => {
      const signal = options?.signal;
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      }, ms);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    }),
}));
const signal = () => new AbortController().signal;

describe('grounded navigation', () => {
  it('plans a detour around a wall and rejects unknown or unsupported space', async () => {
    const w = navigationWorld();
    for (let z = -2; z <= 2; z++) for (let y = 3; y <= 6; y++) w.put(2, y, z);
    const map = collisionMap(w.observe())!;
    const p = await findPath(map, w.body, { x: 4, y: 2.5, z: 0 }, signal());
    expect(p.code).toBeUndefined();
    expect(p.path.some((p) => Math.abs(p.z) === 3)).toBe(true);
    expect(map.clear({ x: 9, y: 3, z: 0 })).toBe(false);
    expect(map.stand({ x: 0, y: 5.501, z: 0 })).toBe(false);
    const missing = w.observe();
    delete missing.navigation;
    expect(collisionMap(missing)).toBeUndefined();
  });
  it.each(['flat', 'wall', 'step', 'down', 'far'] as const)(
    'physically reaches %s using the server integrator',
    async (kind) => {
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
        ],
      });
      const w = navigationWorld(
        kind === 'down' ? { x: 0, y: 3.501, z: 0 } : undefined,
      );
      const target = { x: kind === 'far' ? 11 : 4, y: 2.5, z: 0 };
      if (kind === 'wall')
        for (let z = -2; z <= 2; z++)
          for (let y = 3; y <= 6; y++) w.put(2, y, z);
      if (kind === 'step') {
        for (let x = 2; x <= 5; x++)
          for (let z = -12; z <= 12; z++) w.put(x, 3, z);
        target.y = 3.5;
      }
      if (kind === 'down') w.put(0, 3, 0);
      const timer = setInterval(w.tick, 50);
      try {
        const pending = navigate(
          w.session,
          { type: 'goto', ...target },
          w.observe(),
          signal(),
        );
        let done = false;
        void pending.then(() => {
          done = true;
        });
        for (let i = 0; i < 350 && !done; i++) {
          await vi.advanceTimersByTimeAsync(100);
          await new Promise<void>((r) => setImmediate(r));
        }
        const result = await pending;
        expect(result, JSON.stringify(w.body)).toMatchObject({
          ok: true,
          status: 'arrived',
        });
        expect(
          Math.hypot(w.body.x - target.x, w.body.z - target.z),
        ).toBeLessThan(0.19);
        expect(w.body.grounded).toBe(true);
        expect(w.moves.at(-1)).toMatchObject({ x: 0, z: 0, jump: false });
      } finally {
        clearInterval(timer);
        vi.useRealTimers();
      }
    },
  );
});

async function physics<T>(
  w: ReturnType<typeof navigationWorld>,
  work: () => Promise<T>,
) {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });
  const timer = setInterval(w.tick, 50);
  let done = false;
  try {
    const pending = work();
    void pending.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    for (let i = 0; i < 600 && !done; i++) {
      await vi.advanceTimersByTimeAsync(100);
      await new Promise<void>((r) => setImmediate(r));
    }
    return await pending;
  } finally {
    clearInterval(timer);
    vi.useRealTimers();
  }
}

it('replans when an obstacle is added during movement', async () => {
  const w = navigationWorld();
  const result = await physics(w, async () => {
    setTimeout(() => {
      for (let z = -1; z <= 1; z++) for (let y = 3; y <= 6; y++) w.put(3, y, z);
      w.changed();
    }, 300);
    return navigate(
      w.session,
      { type: 'goto', x: 5, y: 2.5, z: 0 },
      w.observe(),
      signal(),
    );
  });
  expect(result).toMatchObject({ ok: true, status: 'arrived' });
});
it('rejects a low ceiling jump, deep pit, and occupied destination', async () => {
  const w = navigationWorld();
  for (let z = -12; z <= 12; z++) {
    w.put(1, 3, z);
    w.put(0, 5, z);
  }
  const p = await findPath(
    collisionMap(w.observe())!,
    w.body,
    { x: 2, y: 2.5, z: 0 },
    signal(),
  );
  expect(p.code).toBe('no_path_in_known_area');
  const blocked = await navigate(
    w.session,
    { type: 'goto', x: 1, y: 2.5, z: 0 },
    w.observe(),
    signal(),
  );
  expect(blocked.code).toBe('target_blocked');
  const hole = navigationWorld();
  for (let z = -12; z <= 12; z++)
    for (let y = 1; y <= 2; y++) hole.blocks.delete(`1,${y},${z}`);
  expect(
    (
      await findPath(
        collisionMap(hole.observe())!,
        hole.body,
        { x: 3, y: 2.5, z: 0 },
        signal(),
      )
    ).code,
  ).toBe('no_path_in_known_area');
});
it('stops on cancellation and on observation failure', async () => {
  const w = navigationWorld(),
    abort = new AbortController();
  await expect(
    physics(w, async () => {
      setTimeout(() => abort.abort(new Error('cancelled')), 250);
      return navigate(
        w.session,
        { type: 'goto', x: 8, y: 2.5, z: 0 },
        w.observe(),
        abort.signal,
      );
    }),
  ).rejects.toThrow('cancelled');
  expect(w.moves.at(-1)).toMatchObject({ x: 0, z: 0 });
  await expect(
    physics(w, () =>
      navigate(
        {
          ...w.session,
          request: async () => {
            throw Error('offline');
          },
        },
        { type: 'goto', x: 8, y: 2.5, z: 0 },
        w.observe(),
        signal(),
      ),
    ),
  ).rejects.toThrow('offline');
  expect(w.moves.at(-1)).toMatchObject({ x: 0, z: 0 });
});
it('never assumes a truncated or stale observation is a navigation map', async () => {
  const w = navigationWorld(),
    o = w.observe();
  o.navigation!.revision++;
  expect(
    (
      await navigate(
        w.session,
        { type: 'goto', x: 1, y: 2.5, z: 0 },
        o,
        signal(),
      )
    ).code,
  ).toBe('map_unavailable');
  expect(w.moves.filter((m) => m.x || m.z)).toHaveLength(0);
});
it('returns bounded stalled failure even when the server does not move', async () => {
  const w = navigationWorld();
  w.tick = () => {};
  const result = await physics(w, () =>
    navigate(
      w.session,
      { type: 'goto', x: 4, y: 2.5, z: 0 },
      w.observe(),
      signal(),
    ),
  );
  expect(result.ok).toBe(false);
  expect(['stalled', 'no_path_in_known_area']).toContain(result.code);
  expect(w.moves.at(-1)).toMatchObject({ x: 0, z: 0 });
});

import {
  AgentRunner,
  AgentAttention,
  newTask,
  type AgentRunState,
} from '@voxel/agent-runtime';
import { testAgentConfig } from '../../../tests/support/agent-config';
import { toolResponse } from '../../../tests/support/pi-response';
import { toolSchemas } from '../src/agent/tools/schema';
import { worldView } from '../src/world/observe/extract';
import { parseAction } from '../src/world/actions/parse';

it('exposes goto/follow without low-level move and keeps complete maps out of prompts', () => {
  expect(toolSchemas).not.toHaveProperty('move');
  expect(toolSchemas).toHaveProperty('goto');
  expect(toolSchemas).toHaveProperty('follow');
  expect(worldView(navigationWorld().observe())).not.toHaveProperty(
    'navigation',
  );
  expect(() =>
    parseAction(
      { type: 'goto', x: 1, y: 2.5, z: 0 },
      { move: false, chat: true, place: true, remove: true },
    ),
  ).toThrow('权限');
  expect(() =>
    parseAction({ type: 'follow', playerId: 'a', distance: NaN }, false),
  ).toThrow();
});

it('follows across host wakes with no extra model calls, hysteresis, pause/resume, and lost-target recovery', async () => {
  const w = navigationWorld();
  const player = { ...w.observe().self, id: 'human', x: 4 };
  w.players([player]);
  const memory: AgentRunState = {
    ...emptyState(),
    task: { current: newTask('跟随玩家') },
  };
  const config = {
    ...testAgentConfig(),
    maxTurns: 20,
    taskTimeoutMs: 60000,
  };
  const request = vi.fn<typeof fetch>(async () =>
    toolResponse([
      { name: 'follow', arguments: { playerId: 'human', distance: 1.5 } },
    ]),
  );
  const runner = new AgentRunner(undefined, request);
  const run = () =>
    runner.run({ session: w.session, config, signal: signal(), memory });
  await physics(w, async () => {
    await run();
    expect(memory.effects.follow).toBeDefined();
    for (let i = 0; i < 4; i++) await run();
    expect(Math.abs(w.body.x - player.x)).toBeLessThanOrEqual(1.5);
    expect(memory.task.current!.status).toBe('waiting');
    expect(request).toHaveBeenCalledTimes(1);
    const held = w.body.x;
    player.x += 0.2;
    w.players([player]);
    await run();
    expect(w.body.x).toBe(held);
    memory.task.current!.status = 'paused';
    player.x = 7;
    w.players([player]);
    await run();
    expect(w.body.x).toBe(held);
    memory.task.current!.status = 'running';
    for (let i = 0; i < 5; i++) await run();
    expect(Math.abs(w.body.x - player.x)).toBeLessThanOrEqual(1.5);
    w.players([]);
    await run();
    expect(memory.effects.follow!.lastResult!.code).toBe('target_not_visible');
    expect(w.moves.at(-1)).toMatchObject({ x: 0, z: 0 });
    player.x = 9;
    w.players([player]);
    // JSON round-trip models the durable follow state used after an explicit resume.
    memory.effects.follow = JSON.parse(JSON.stringify(memory.effects.follow));
    for (let i = 0; i < 4; i++) await run();
    expect(Math.abs(w.body.x - player.x)).toBeLessThanOrEqual(1.5);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

it('runs come-here through native tools and only completes after observed arrival', async () => {
  const w = navigationWorld();
  for (let z = -1; z <= 1; z++) for (let y = 3; y <= 5; y++) w.put(2, y, z);
  const player = { ...w.observe().self, id: 'human', x: 4 };
  w.players([player]);
  const memory: AgentRunState = emptyState();
  const attention = new AgentAttention();
  attention.push(
    {
      seq: 1,
      at: Date.now(),
      actor: 'human',
      actorKind: 'human',
      type: 'chat',
      data: {
        name: 'Player',
        kind: 'text',
        text: '到我这里来',
        scope: 'private',
        recipients: ['ai'],
      },
    },
    'ai',
  );
  let calls = 0;
  const request = vi.fn<typeof fetch>(async () =>
    toolResponse(
      ++calls === 1
        ? [{ name: 'start_task', arguments: { goal: '到玩家 human 位置' } }]
        : calls === 2
          ? [
              {
                name: 'goto',
                arguments: { x: player.x, y: player.y, z: player.z },
              },
            ]
          : [{ name: 'complete_task', arguments: { summary: '已到达' } }],
    ),
  );
  const config = {
    ...testAgentConfig(),
    taskTimeoutMs: 60000,
  };
  await physics(w, () =>
    new AgentRunner(undefined, request).run({
      session: w.session,
      config,
      signal: signal(),
      memory,
      attention,
    }),
  );
  expect(memory.task.current!.status).toBe('completed');
  expect(Math.abs(w.body.x - player.x)).toBeLessThan(0.18);
  expect(request).toHaveBeenCalledTimes(3);
});

it('keeps stall rate below 5% across 100 reproducible reachable terrain cases', async () => {
  let failed = 0;
  const failures: unknown[] = [];
  for (let seed = 0; seed < 100; seed++) {
    const w = navigationWorld();
    const direction = seed % 2 ? 1 : -1;
    const kind = Math.floor(seed / 2) % 4;
    const target = {
      type: 'goto' as const,
      x: direction * (4 + (seed % 3)),
      y: kind === 2 ? 3.5 : 2.5,
      z: (seed % 3) - 1,
    };
    if (kind === 1 || kind === 3) {
      for (let z = -(seed % 3); z <= seed % 3; z++)
        for (let y = 3; y <= 5; y++) w.put(direction * 2, y, z);
    }
    if (kind === 2)
      for (let x = 2; x <= 7; x++)
        for (let z = -12; z <= 12; z++) w.put(direction * x, 3, z);
    if (kind === 3) {
      w.put(direction * 4, 3, 2);
      w.put(direction * 4, 4, 2);
    }
    const result = await physics(w, () =>
      navigate(w.session, target, w.observe(), signal()),
    );
    if (!result.ok) {
      failed++;
      failures.push({ seed, code: result.code });
    }
  }
  expect(failed, JSON.stringify(failures)).toBeLessThan(5);
  console.log(
    `Navigation reachable-case matrix: ${100 - failed}/100 arrived; ${failed}% failure/stall rate.`,
  );
}, 30000);

it('stops follow on revoked movement permission, expired time budget, and checkpoint failure', async () => {
  for (const kind of ['permission', 'budget', 'persistence'] as const) {
    const w = navigationWorld();
    w.players([{ ...w.observe().self, id: 'human', x: 5 }]);
    const task = newTask('跟随');
    const memory: AgentRunState = {
      ...emptyState(),
      task: { current: task },
      effects: {
        follow: {
          action: { type: 'follow', playerId: 'human', distance: 1.5 },
          taskStartedAt: task.startedAt,
          pursuing: true,
        },
      },
    };
    const config = {
      ...testAgentConfig(),
      permissions: {
        move: kind !== 'permission',
        chat: true,
        place: false,
        remove: false,
      },
      taskTimeoutMs: kind === 'budget' ? 1 : 60000,
    };
    if (kind === 'budget') task.elapsedMs = 10;
    const request = vi.fn<typeof fetch>();
    const checkpoint = async () => {
      if (kind === 'persistence') throw Error('disk failure');
    };
    const pending = new AgentRunner(undefined, request).run({
      session: w.session,
      config,
      signal: signal(),
      memory,
      checkpoint,
    });
    if (kind === 'persistence')
      await expect(pending).rejects.toThrow('disk failure');
    else await pending;
    expect(task.status).toBe(kind === 'budget' ? 'budget' : 'blocked');
    expect(w.moves.some((m) => m.x || m.z || m.jump)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  }
});

it('cancels stored follow through authorized task control and rejects premature completion', async () => {
  const w = navigationWorld();
  const task = newTask('跟随', 'human', 'human');
  const memory: AgentRunState = {
    ...emptyState(),
    task: { current: task },
    effects: {
      follow: {
        action: { type: 'follow', playerId: 'human', distance: 1.5 },
        taskStartedAt: task.startedAt,
        pursuing: false,
      },
    },
  };
  const attention = new AgentAttention();
  attention.push(
    {
      seq: 1,
      at: Date.now(),
      actor: 'human',
      actorKind: 'human',
      type: 'chat',
      data: {
        text: '取消任务',
        kind: 'text',
        scope: 'private',
        recipients: ['ai'],
      },
    },
    'ai',
  );
  const request = vi.fn<typeof fetch>(async () =>
    toolResponse([
      {
        name: 'cancel_task',
        arguments: {},
      },
    ]),
  );
  await new AgentRunner(undefined, request).run({
    session: w.session,
    config: testAgentConfig(),
    signal: signal(),
    memory,
    attention,
  });
  expect(memory.effects.follow).toBeUndefined();
  expect(memory.task.current!.status).toBe('cancelled');
  expect(w.moves.some((m) => m.x || m.z)).toBe(false);
});

import { TaskService } from '../src/agent/task/service';
import { executeBatch } from '../src/world/actions/batch';
it('refuses to complete an active follow and treats an interrupted goto as unfinished', async () => {
  const task = newTask('跟随');
  const memory: AgentRunState = {
    ...emptyState(),
    task: { current: task },
    effects: {
      follow: {
        action: { type: 'follow', playerId: 'human', distance: 1.5 },
        taskStartedAt: task.startedAt,
        pursuing: true,
      },
    },
  };
  expect(() =>
    new TaskService(memory).finish(new TaskService(memory).lease(), {
      status: 'completed',
      reason: '完成',
    }),
  ).toThrow('未确认');
  const w = navigationWorld();
  let pending = false;
  const move = w.session.move;
  w.session.move = (x, z, jump) => {
    move(x, z, jump);
    if (x || z) pending = true;
  };
  const outcome = await physics(w, () =>
    executeBatch(
      w.session,
      [{ type: 'goto', x: 5, y: 2.5, z: 0 }],
      w.observe(),
      false,
      signal(),
      { pending: () => pending },
    ),
  );
  expect(outcome.batch).toMatchObject({ ok: false, stopReason: 'message' });
  expect(outcome.batch.results[0].status).toBe('interrupted');
  expect(w.body.x).toBeLessThan(1);
});
