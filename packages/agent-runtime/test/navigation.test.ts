import {
  AgentRunner,
  AgentAttention,
  emptyState,
  newTask,
  type AgentRunState,
} from '@voxel/agent-runtime';
import { it, expect, vi } from 'vitest';
import { navigationWorld } from '../../../tests/support/navigation-world';
import { physics, signal } from './navigation-physics';
import { testAgentConfig } from '../../../tests/support/agent-config';
import { toolResponse } from '../../../tests/support/pi-response';
import { toolSchemas } from '../src/agent/tools/schema';
import { worldView } from '../src/world/observe/extract';
import { parseAction } from '../src/world/actions/parse';
import { TaskService } from '../src/agent/task/service';
import { executeBatch } from '../src/world/actions/batch';
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
    parseAction(
      { type: 'follow', playerId: 'a', distance: NaN },
      { move: true, chat: true, place: false, remove: false },
    ),
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
      { move: true, chat: true, place: false, remove: false },
      signal(),
      { pending: () => pending },
    ),
  );
  expect(outcome.batch).toMatchObject({ ok: false, stopReason: 'message' });
  expect(outcome.batch.results[0].status).toBe('interrupted');
  expect(w.body.x).toBeLessThan(1);
});
