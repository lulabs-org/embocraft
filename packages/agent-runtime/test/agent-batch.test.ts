import { executeTaskActions } from '../src/agent/action/executor';
import { TaskService, RequestBudget } from '@voxel/agent-runtime';
import { emptyState } from '@voxel/agent-runtime';
import type { Edit } from '@voxel/shared';
import { parseActions } from '../src/world/actions/parse';
import {
  modelRequest,
  worldTool,
  type ModelResponder,
} from '../../../tests/support/model-fixture';
import { AgentRunner } from '@voxel/agent-runtime';
import { describe, expect, it, vi } from 'vitest';
import {
  executeBatch,
  newTask,
  AgentAttention,
  restoreBatchHistory,
  type AgentAction,
  type AgentSession,
  type Observation,
  type AgentRunState,
  type BatchResult,
  type BuildResult,
} from '@voxel/agent-runtime';
import { testAgentConfig } from '../../../tests/support/agent-config';

const edit = (x = 1, material: 'wood' | null = 'wood'): AgentAction => ({
  type: 'edit',
  x,
  y: 3,
  z: 0,
  material,
});
const chat: AgentAction = { type: 'chat', text: '进展汇报' };
const move: AgentAction = {
  type: 'move',
  x: 1,
  z: 0,
  jump: false,
  durationMs: 100,
};
const config = () => ({
  ...testAgentConfig(),
  permissions: { move: true, chat: true, place: true, remove: true },
  timeoutMs: 2000,
});
function fixture() {
  const world: Observation = {
    id: 'obs',
    revision: 1,
    radius: 8,
    blocks: [],
    players: [],
    events: [],
    allowedActions: [],
    self: {
      id: 'ai',
      name: 'AI',
      kind: 'ai-agent',
      connected: true,
      x: 0,
      y: 2.5,
      z: 0,
      yaw: 0,
    },
  };
  const observe = vi.fn(async () => structuredClone(world));
  const request = vi.fn(
    async (
      type: string,
      payload?: Edit & { revision?: number },
    ): Promise<
      | Observation
      | { id?: string; ok: boolean; error?: string; revision: number }
    > => {
      if (type === 'observe') return observe();
      if (type === 'edit') {
        if (payload!.revision !== world.revision)
          return { ok: false, revision: world.revision, error: 'conflict' };
        world.blocks = world.blocks.filter(
          (b) =>
            !(b.x === payload!.x && b.y === payload!.y && b.z === payload!.z),
        );
        if (payload!.material)
          world.blocks.push({
            x: payload!.x,
            y: payload!.y,
            z: payload!.z,
            material: payload!.material,
          });
        world.revision++;
      }
      return { id: 'result', ok: true, revision: world.revision };
    },
  );
  const sendMove = vi.fn((x: number, z: number) => {
    world.self.x += x / 2;
    world.self.z += z / 2;
  });
  const session: AgentSession = {
    observe,
    request: request as AgentSession['request'],
    move: sendMove,
  };
  const abort = new AbortController();
  const history: BatchResult[] = [];
  const builds: BuildResult[] = [];
  const run = (actions: AgentAction[], options = {}) =>
    executeBatch(
      session,
      actions,
      structuredClone(world),
      { move: true, chat: true, place: true, remove: true },
      abort.signal,
      {
        checkpoint: (value) => history.push(value),
        buildCheckpoint: (_action, value) => builds.push(value),
        ...options,
      },
    );
  return {
    world,
    observe,
    request,
    sendMove,
    session,
    abort,
    history,
    builds,
    run,
  };
}

describe('sequential batch effects', () => {
  it('validates an invalid tail before the first side effect', async () => {
    const f = fixture();
    await expect(
      f.run([chat, { type: 'shell' } as unknown as AgentAction]),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('refreshes positions/revisions, records all steps and runs without another model call', async () => {
    const f = fixture();
    const { batch } = await f.run([move, edit(), edit(2), chat]);
    expect(batch.ok).toBe(true);
    expect(batch.results.map((r) => r.status)).toEqual(
      Array(4).fill('succeeded'),
    );
    expect(batch.results[0]).toMatchObject({
      before: { x: 0 },
      after: { x: 0.5 },
    });
    expect(
      f.request.mock.calls
        .filter(([t]) => t === 'edit')
        .map(([, p]) => p!.revision),
    ).toEqual([1, 2]);
    expect(f.observe).toHaveBeenCalledTimes(3);
    expect(
      f.history.some(
        (b) =>
          b.results[1].status === 'succeeded' &&
          b.results[2].status === 'pending',
      ),
    ).toBe(true);
  });
  it('stops at the second failure without executing the trailing chat', async () => {
    const f = fixture();
    f.request
      .mockResolvedValueOnce({ ok: true, revision: 2 })
      .mockResolvedValueOnce({ ok: false, error: 'occupied', revision: 2 });
    const { batch } = await f.run([edit(), edit(2), chat]);
    expect(batch.stopReason).toBe('failed');
    expect(batch.results.map((r) => r.status)).toEqual([
      'succeeded',
      'failed',
      'pending',
    ]);
    expect(batch.remaining).toEqual([chat]);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('does not build after movement with no observed progress', async () => {
    const f = fixture();
    f.sendMove.mockImplementation(() => {});
    const { batch } = await f.run([move, edit()]);
    expect(batch.stopReason).toBe('movement_stalled');
    expect(f.request).not.toHaveBeenCalled();
    expect(f.sendMove).toHaveBeenLastCalledWith(0, 0, false);
  });
  it('keeps an acknowledged edit when the following observation fails', async () => {
    const f = fixture();
    f.observe.mockRejectedValueOnce(Error('offline'));
    const { batch } = await f.run([edit(), chat]);
    expect(batch.stopReason).toBe('observation_failed');
    expect(batch.results[0].status).toBe('succeeded');
    expect(f.world.blocks).toHaveLength(1);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('leaves timed-out requests unknown and never replays them', async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(Error('request timeout'));
    const { batch } = await f.run([edit(), chat]);
    expect(batch.results[0].status).toBe('unknown');
    expect(batch.stopReason).toBe('unknown');
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('aborts an in-flight request immediately and ignores late responses', async () => {
    const f = fixture();
    let release!: (value: Awaited<ReturnType<typeof f.request>>) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const running = f.run([edit(), chat]);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalled());
    f.abort.abort();
    const { batch } = await running;
    expect(batch.results[0].status).toBe('unknown');
    release({ ok: true, revision: 2 });
    await Promise.resolve();
    expect(batch.results[0].status).toBe('unknown');
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('yields after the current action, preserving the unexecuted tail', async () => {
    const f = fixture();
    const { batch } = await f.run([edit(), chat], {
      pending: () => f.world.revision > 1,
    });
    expect(batch.stopReason).toBe('message');
    expect(batch.results.map((r) => r.status)).toEqual([
      'succeeded',
      'pending',
    ]);
  });
  it('paces consecutive chat messages and enforces private routing after refresh', async () => {
    const f = fixture();
    const sent: number[] = [];
    f.world.events = [
      {
        seq: 1,
        type: 'chat',
        actor: 'human',
        actorKind: 'human',
        at: 0,
        data: { scope: 'private', recipients: ['ai'], text: 'do it' },
      },
    ];
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (t, p) => {
      if (t === 'chat') sent.push(Date.now());
      return original(t, p);
    });
    await f.run([edit(), chat, chat]);
    expect(sent[1] - sent[0]).toBeGreaterThanOrEqual(340);
    for (const [, payload] of f.request.mock.calls.filter(
      ([t]) => t === 'chat',
    ))
      expect(payload).toMatchObject({
        scope: 'private',
        recipients: ['human'],
      });
  });
  it('preserves acknowledged deletions and pending/uncertain build work on cancellation', async () => {
    const f = fixture();
    f.world.blocks.push(
      { x: 1, y: 3, z: 0, material: 'wood' },
      { x: 2, y: 3, z: 0, material: 'wood' },
    );
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (t, p) => {
      if (t === 'edit' && p!.x === 2) {
        setTimeout(() => f.abort.abort(), 0);
        return new Promise(() => {});
      }
      return original(t, p);
    });
    const { batch } = await f.run([
      {
        type: 'build',
        blocks: [
          { x: 1, y: 3, z: 0, material: null },
          { x: 2, y: 3, z: 0, material: null },
        ],
      },
      chat,
    ]);
    expect(batch.results[0].status).toBe('unknown');
    expect(f.builds.at(-1)).toMatchObject({
      completed: 1,
      remaining: [{ x: 2 }],
      uncertain: [{ x: 2 }],
    });
    expect(f.world.blocks.map((b) => b.x)).toEqual([2]);
    expect(f.request.mock.calls.filter(([t]) => t === 'chat')).toHaveLength(0);
  });
  it('returns a partial build and does not continue the outer sequence', async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((t, p) =>
      t === 'edit' && p!.x === 1
        ? Promise.resolve({
            ok: false,
            error: 'out-of-reach',
            revision: f.world.revision,
          })
        : original(t, p),
    );
    const { batch } = await f.run([
      {
        type: 'build',
        blocks: [
          { x: 1, y: 3, z: 0, material: 'wood' },
          { x: 2, y: 3, z: 0, material: 'wood' },
        ],
      },
      chat,
    ]);
    expect(batch.stopReason).toBe('failed');
    expect(f.builds.at(-1)).toMatchObject({
      completed: 1,
      remaining: [{ x: 1 }],
    });
    expect(f.request.mock.calls.filter(([t]) => t === 'chat')).toHaveLength(0);
  });
});

function runtimeFixture() {
  const f = fixture();
  const memory: AgentRunState = {
    ...emptyState(),
    task: { current: newTask('build') },
  };
  const attention = new AgentAttention();
  const planner = {
    decide: vi.fn<ModelResponder>(),
    lastUsage: { tokens: 50, estimated: false },
  };
  let seq = 0;
  const message = (scope = 'private', actor = 'human') =>
    attention.push(
      {
        seq: ++seq,
        actor,
        actorKind: 'human',
        type: 'chat',
        at: 0,
        data: { text: '你好', scope, recipients: ['ai'], kind: 'text' },
      },
      'ai',
    );
  const saved: AgentRunState[] = [];
  const step = (cfg = config()) =>
    new AgentRunner(undefined, modelRequest(planner.decide)).run({
      session: f.session,
      config: cfg,
      signal: f.abort.signal,
      memory,
      attention,
      checkpoint: () => {
        saved.push(structuredClone(memory));
      },
    });
  return { ...f, memory, attention, planner, message, step, saved };
}

describe('batch task lifecycle', () => {
  it('charges once, prevents immediate completion and confirms on a later model turn', async () => {
    const f = runtimeFixture();
    f.planner.decide
      .mockResolvedValueOnce([
        worldTool(edit()),
        worldTool(edit(2)),
        worldTool(chat),
        { name: 'complete_task', arguments: { summary: '推进任务' } },
      ])
      .mockResolvedValueOnce([
        { name: 'complete_task', arguments: { summary: '推进任务' } },
      ]);
    await f.step();
    expect(f.memory.task.current).toMatchObject({
      status: 'completed',
      calls: 2,
      tokens: 100,
    });
    expect(
      f.saved.some(
        (state) =>
          state.task.current?.status === 'running' &&
          state.task.current.calls === 1,
      ),
    ).toBe(true);
    expect(f.world.blocks.map((block) => block.x)).toEqual([1, 2]);
    expect(
      f.request.mock.calls.filter(([name]) => name === 'chat'),
    ).toHaveLength(1);
    await f.step();
    expect(f.planner.decide).toHaveBeenCalledTimes(2);
  });
  it('interrupts at a boundary, handles the greeting, and replans instead of replaying the tail', async () => {
    const f = runtimeFixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (t, p) => {
      const r = await original(t, p);
      if (t === 'edit') f.message();
      return r;
    });
    f.planner.decide
      .mockResolvedValueOnce([
        worldTool(edit()),
        worldTool(edit(2)),
        { name: 'complete_task', arguments: { summary: '推进任务' } },
      ])
      .mockResolvedValueOnce([worldTool(chat)])
      .mockResolvedValueOnce([
        { name: 'request_input', arguments: { question: '推进任务' } },
      ]);
    await f.step();
    expect(f.world.blocks.map((b) => b.x)).toEqual([1]);
    expect(f.planner.decide).toHaveBeenCalledTimes(3);
    expect(f.memory.task.current?.status).toBe('needs_input');
    await f.step();
    expect(f.planner.decide).toHaveBeenCalledTimes(3);
  });
  it('does not drop queued addressed replies or disclose private batch history', async () => {
    const f = runtimeFixture();
    f.memory.task.current = {
      ...newTask('secret', 'owner', 'owner'),
      status: 'paused',
    };
    f.memory.effects.previous = {
      actions: [chat],
      results: [{ action: chat, status: 'succeeded', result: { ok: true } }],
      remaining: [],
      ok: true,
      stopReason: 'completed',
    };
    f.message('public', 'other');
    f.message('public', 'third');
    f.planner.decide.mockResolvedValue([worldTool(chat)]);
    await f.step();
    await f.step();
    expect(f.request.mock.calls.filter(([t]) => t === 'chat')).toHaveLength(2);
    expect(f.memory.effects.previous).toMatchObject({
      actions: [chat],
      results: [{ status: 'succeeded' }],
    });
    for (const [, context] of f.planner.decide.mock.calls)
      expect(context).toEqual({});
  });
  it('counts actual edits as progress even when the last action is chat', async () => {
    const f = runtimeFixture();
    f.memory.health.noProgress = 2;
    f.planner.decide
      .mockResolvedValueOnce([worldTool(edit()), worldTool(chat)])
      .mockResolvedValueOnce([
        {
          name: 'wait_for',
          arguments: { condition: 'world', reason: '等待变化' },
        },
      ]);
    await f.step();
    expect(f.saved.some((state) => state.health.noProgress === 0)).toBe(true);
    expect(f.memory.task.current?.status).toBe('waiting');
  });
  it('stops physical actions at the task deadline without executing the tail', async () => {
    const f = runtimeFixture();
    const cfg = { ...config(), taskTimeoutMs: 50 };
    const outcome = await executeTaskActions(
      f.session,
      [{ ...move, durationMs: 1000 } as AgentAction, edit()],
      f.world,
      cfg,
      f.abort.signal,
      f.memory,
      new RequestBudget(
        cfg,
        { calls: 0, tokens: 0, estimated: false },
        f.memory.task.current,
      ),
      new TaskService(f.memory).lease(),
      async () => {},
    );
    expect(f.request).not.toHaveBeenCalled();
    expect(outcome.batch.ok).toBe(false);
    expect(outcome.batch.results[1].status).toBe('pending');
    expect(f.sendMove).toHaveBeenLastCalledWith(0, 0, false);
  });
  it('restores batch history without converting single-action records', () => {
    expect(
      restoreBatchHistory({ action: chat, result: { ok: true } }),
    ).toBeUndefined();
    const history: BatchResult = {
      actions: [chat],
      results: [{ action: chat, status: 'executing' }],
      remaining: [],
      ok: false,
      stopReason: 'executing',
    };
    expect(restoreBatchHistory(history)).toMatchObject({
      ok: false,
      stopReason: 'unknown',
      results: [{ status: 'unknown' }],
    });
    expect(history.results[0].status).toBe('executing');
  });
  it('does not infer a deleted block from an incomplete or distant observation', async () => {
    const f = runtimeFixture();
    const block = { x: 10, y: 3, z: 0, material: null } as const;
    f.memory.effects.unfinishedBuild = {
      action: { type: 'build', blocks: [block] },
      result: {
        ok: false,
        total: 1,
        completed: 0,
        skipped: 0,
        remaining: [block],
        uncertain: [block],
        failures: [],
        note: 'unknown',
      },
    };
    f.planner.decide.mockResolvedValue([
      { name: 'complete_task', arguments: { summary: '推进任务' } },
    ]);
    await f.step();
    expect(f.memory.effects.unfinishedBuild?.result.remaining).toEqual([block]);
    expect(f.memory.task.current?.status).toBe('blocked');
  });
});

it('preserves older pending blueprint coordinates when only a subset is rebuilt', async () => {
  const f = runtimeFixture();
  const blocks = [1, 2].map((x) => ({
    x,
    y: 3,
    z: 0,
    material: 'wood' as const,
  }));
  f.memory.effects.unfinishedBuild = {
    action: { type: 'build', blocks },
    result: {
      ok: false,
      total: 2,
      completed: 0,
      skipped: 0,
      remaining: blocks,
      failures: [],
      note: 'partial',
    },
  };
  f.planner.decide
    .mockResolvedValueOnce([
      { name: 'build', arguments: { blocks: [blocks[0]] } },
    ])
    .mockResolvedValue([
      { name: 'request_input', arguments: { question: '剩余方块待确认' } },
    ]);
  await f.step();
  expect(f.memory.effects.unfinishedBuild?.result.remaining).toEqual([
    blocks[1],
  ]);
  expect(f.memory.task.current?.status).toBe('needs_input');
});

it('keeps an unconfirmed deletion outside the 500-block cutoff, even inside radius 8', async () => {
  const f = runtimeFixture();
  f.world.blocks = Array.from({ length: 500 }, (_, i) => ({
    x: (i % 10) / 100,
    y: 1,
    z: Math.floor(i / 10) / 100,
    material: 'stone',
  }));
  const block = { x: 6, y: 3, z: 0, material: null } as const;
  f.memory.effects.unfinishedBuild = {
    action: { type: 'build', blocks: [block] },
    result: {
      ok: false,
      total: 1,
      completed: 0,
      skipped: 0,
      remaining: [block],
      uncertain: [block],
      failures: [],
      note: 'unknown',
    },
  };
  f.planner.decide.mockResolvedValue([
    { name: 'complete_task', arguments: { summary: '推进任务' } },
  ]);
  await f.step();
  expect(f.memory.effects.unfinishedBuild?.result.remaining).toEqual([block]);
  expect(f.memory.task.current?.status).toBe('blocked');
});

it('confirms an unknown deletion by fresh complete observation without replaying the request', async () => {
  const f = runtimeFixture();
  const block = { x: 1, y: 3, z: 0, material: null } as const;
  f.memory.effects.unfinishedBuild = {
    action: { type: 'build', blocks: [block] },
    result: {
      ok: false,
      total: 1,
      completed: 0,
      skipped: 0,
      remaining: [block],
      uncertain: [block],
      failures: [],
      note: 'unknown',
    },
  };
  f.planner.decide.mockResolvedValue([
    { name: 'complete_task', arguments: { summary: '推进任务' } },
  ]);
  await f.step();
  expect(f.memory.effects.unfinishedBuild).toBeUndefined();
  expect(f.request).not.toHaveBeenCalled();
  expect(f.memory.task.current?.status).toBe('completed');
});

it('stops repeated failed tools without executing trailing chat', async () => {
  const f = runtimeFixture();
  f.request.mockResolvedValue({ ok: false, error: 'conflict', revision: 1 });
  f.planner.decide.mockResolvedValue([worldTool(edit()), worldTool(chat)]);
  await f.step();
  expect(f.planner.decide).toHaveBeenCalledTimes(3);
  expect(f.memory.task.current?.status).toBe('blocked');
  expect(f.request.mock.calls.filter(([type]) => type === 'chat')).toEqual([]);
});

it('does not repeat already empty deletions when resuming a larger original build', async () => {
  const f = fixture();
  f.world.blocks.push({ x: 2, y: 3, z: 0, material: 'wood' });
  const { batch } = await f.run([
    {
      type: 'build',
      blocks: [
        { x: 1, y: 3, z: 0, material: null },
        { x: 2, y: 3, z: 0, material: null },
      ],
    },
  ]);
  expect(batch.ok).toBe(true);
  expect(
    f.request.mock.calls.filter(([t]) => t === 'edit').map(([, p]) => p!.x),
  ).toEqual([2]);
  expect(f.builds.at(-1)).toMatchObject({
    skipped: 1,
    completed: 1,
    remaining: [],
  });
});

describe('independent action permissions', () => {
  const all = { move: true, chat: true, place: true, remove: true };
  it.each([
    ['move', move],
    ['chat', chat],
    ['place', edit()],
    ['remove', edit(1, null)],
    [
      'place',
      {
        type: 'house',
        x: 1,
        y: 3,
        z: 1,
        width: 3,
        depth: 3,
        height: 4,
        material: 'wood',
        door: 'south',
      },
    ],
  ] as const)(
    'blocks %s in parsing and execution before any batch effects',
    async (permission, action) => {
      const f = fixture();
      const policy = { ...all, [permission]: false };
      expect(() => parseActions([action], policy)).toThrow('权限');
      await expect(
        executeBatch(
          f.session,
          [{ type: 'wait' }],
          f.world,
          policy,
          f.abort.signal,
        ),
      ).resolves.toBeDefined();
      f.request.mockClear();
      f.observe.mockClear();
      await expect(
        executeBatch(
          f.session,
          [edit(2), action as AgentAction],
          f.world,
          policy,
          f.abort.signal,
        ),
      ).rejects.toThrow('权限');
      expect(f.request).not.toHaveBeenCalled();
      expect(f.sendMove).not.toHaveBeenCalled();
      expect(f.observe).not.toHaveBeenCalled();
    },
  );
  it('permits place-only houses, remove-only batches and rejects mixed unauthorized builds', async () => {
    const house = {
      type: 'house',
      x: 1,
      y: 3,
      z: 1,
      width: 3,
      depth: 3,
      height: 4,
      material: 'wood',
      door: 'south',
    };
    expect(parseActions([house], { ...all, remove: false })[0].type).toBe(
      'house',
    );
    expect(
      parseActions(
        [{ type: 'build', blocks: [{ x: 1, y: 3, z: 1, material: null }] }],
        { ...all, place: false },
      )[0].type,
    ).toBe('build');
    const f = fixture();
    await expect(
      executeBatch(
        f.session,
        [
          {
            type: 'build',
            blocks: [
              { x: 1, y: 3, z: 1, material: 'wood' },
              { x: 2, y: 3, z: 1, material: null },
            ],
          },
        ],
        f.world,
        { ...all, remove: false },
        f.abort.signal,
      ),
    ).rejects.toThrow('权限');
    expect(f.request).not.toHaveBeenCalled();
  });
  it('records replies without sending chat when chat permission is disabled', async () => {
    const f = runtimeFixture();
    f.memory.task.current!.status = 'paused';
    f.message();
    f.planner.decide.mockResolvedValue([
      { name: 'reply', arguments: { text: '进展汇报' } },
    ]);
    await f.step({ ...config(), permissions: { ...all, chat: false } });
    expect(f.request.mock.calls.filter(([type]) => type === 'chat')).toEqual(
      [],
    );
    expect(f.memory.health.lastResponse).toBe('进展汇报');
  });
  it.each(['owner', 'ended'] as const)(
    'does not send the %s task-control receipt without chat permission',
    async (scenario) => {
      const f = runtimeFixture();
      f.message();
      f.memory.task.current!.owner =
        scenario === 'owner' ? 'someone-else' : 'human';
      f.memory.task.current!.status =
        scenario === 'owner' ? 'paused' : 'completed';
      f.planner.decide.mockResolvedValue([
        { name: 'resume_task', arguments: {} },
      ]);
      await f.step({ ...config(), permissions: { ...all, chat: false } });
      expect(f.request.mock.calls.filter(([type]) => type === 'chat')).toEqual(
        [],
      );
      expect(f.memory.task.current!.status).toBe(
        scenario === 'owner' ? 'paused' : 'completed',
      );
    },
  );
});

it('records an action start timestamp before executing and retains it in checkpoints', async () => {
  const { run, history } = fixture();
  const before = Date.now();
  const { batch } = await run([chat]);
  const at = batch.results[0].startedAt!;
  expect(at).toBeGreaterThanOrEqual(before);
  expect(at).toBeLessThanOrEqual(Date.now());
  expect(history[0].results[0].startedAt).toBeUndefined();
  expect(
    history.find((value) => value.results[0].status === 'executing')?.results[0]
      .startedAt,
  ).toBe(at);
});
