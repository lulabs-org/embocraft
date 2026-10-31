import { AgentRuntimeError, type Session } from '@voxel/agent-runtime';
import { AgentRunner } from '@voxel/agent-runtime/testing';

import {
  DEFAULT_TASK_LIMITS,
  type TaskPlanDraft,
  type TaskTiming,
  type WorldEvent,
} from '@voxel/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ModelResponder } from '../../../tests/support/model-fixture';
import {
  scriptedModelFactory,
  testObservation,
} from '../../../tests/support/model-fixture';
import { toolResponse } from '../../../tests/support/pi-response';
import { AICharacterManager } from '../src/modules/ai-characters';
import {
  bootstrapProviders,
  MemoryProviderRepository,
} from './helpers/memory-storage';
let store: MemoryProviderRepository, manager: AICharacterManager;

let now: number;
const response = (
  status: 'completed' | 'running' | 'waiting' = 'completed',
): Awaited<ReturnType<ModelResponder>> => [
  status === 'completed'
    ? { name: 'complete_task', arguments: { summary: '完成一次观察' } }
    : status === 'running'
      ? { name: 'observe', arguments: {} }
      : {
          name: 'wait_for',
          arguments: { condition: 'world', reason: '完成一次观察' },
        },
];
const decide = vi.fn<ModelResponder>();
function session() {
  const leaves: (() => void)[] = [];
  return {
    join: async () => {},
    close: async () => {
      leaves.forEach((f) => f());
    },
    move: vi.fn(),
    onEvent: undefined as ((event: WorldEvent) => void) | undefined,
    room: {
      sessionId: 'fixture-player',
      onMessage: () => {},
      onLeave: (f: () => void) => leaves.push(f),
      connection: { close: () => {} },
    },
    observe: async () => testObservation(),
    request: vi.fn(async () => ({ ok: true })),
  };
}
let currentSession: ReturnType<typeof session>;
function build() {
  return new AICharacterManager(store, 'ws://fixture', store.archive, {
    session: () => {
      currentSession = session();
      return currentSession as unknown as Session;
    },
    model: scriptedModelFactory(() => ({
      respond: decide,
      tokens: 600,
    })),
  });
}
const draft = (timing: TaskTiming = { kind: 'immediate' }): TaskPlanDraft => ({
  name: '隔离巡查',
  goal: '观察附近后结束',
  timing,
  timeZone: 'Asia/Shanghai',
  limits: { ...DEFAULT_TASK_LIMITS },
  totalTokenBudget: 500000,
});
async function idle(timeout = 5000) {
  await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('idle'), {
    timeout,
  });
}
async function role() {
  const j = manager.create({
    providerId: 'deepseek',
    name: '隔离角色',
    goal: '',
  });
  await idle();
  return j.id;
}
beforeEach(async () => {
  store = new MemoryProviderRepository();
  await bootstrapProviders(store);
  await store.save(
    {
      name: 'DeepSeek',
      type: 'deepseek',
      apiKey: 'fixture',
      defaultModel: 'deepseek-flash',
    },
    'deepseek',
  );
  decide.mockReset().mockImplementation(async () => response());
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  manager = build();
});
afterEach(async () => {
  await manager.close().catch(() => {});
  vi.restoreAllMocks();
});
it('persists immediate runs, deduplicates create and manual requests, and preserves history', async () => {
  const id = await role();
  const p = await manager.tasks.createTaskPlan(id, {
    ...draft(),
    requestId: 'create-1',
  });
  await idle();
  expect(
    (
      await manager.tasks.createTaskPlan(id, {
        ...draft(),
        requestId: 'create-1',
      })
    ).id,
  ).toBe(p.id);
  expect(manager.tasks.taskRuns(id, p.id).items[0]).toMatchObject({
    status: 'completed',
    totalTokens: 600,
    task: { calls: 1 },
  });
  await manager.tasks.controlTaskPlan(id, p.id, 'run', { requestId: 'run-2' });
  await idle();
  await manager.tasks.controlTaskPlan(id, p.id, 'run', { requestId: 'run-2' });
  expect(decide).toHaveBeenCalledTimes(2);
  expect(manager.tasks.taskRuns(id, p.id).items).toHaveLength(2);
  const disk = JSON.parse(store.archive.json!);
  expect(disk.version).toBe(3);
  expect(disk.runs).toHaveLength(2);
});
it('reserves durably before inference', async () => {
  const id = await role();
  decide.mockImplementation(async () => {
    const disk = JSON.parse(store.archive.json!);
    expect(disk.runs).toHaveLength(1);
    expect(disk.characters[0].currentRunId).toBe(disk.runs[0].id);
    return response();
  });
  await manager.tasks.createTaskPlan(id, draft());
  await idle();
  expect(decide).toHaveBeenCalledOnce();
});
it('does not start or retain a reservation when persistence fails', async () => {
  const id = await role();
  store.archive.saveError = new Error('fixture storage failure');
  try {
    await expect(manager.tasks.createTaskPlan(id, draft())).rejects.toThrow();
    expect(decide).not.toHaveBeenCalled();
    expect(manager.tasks.taskPlans(id)).toHaveLength(0);
  } finally {
    store.archive.saveError = undefined;
  }
});
it('queues simultaneous plans without replacing an occupied role', async () => {
  const id = await role();
  decide.mockImplementation(async () => response('waiting'));
  const a = await manager.tasks.createTaskPlan(
    id,
    draft({ kind: 'interval', everyMs: 60000 }),
  );
  const b = await manager.tasks.createTaskPlan(
    id,
    draft({ kind: 'interval', everyMs: 60000 }),
  );
  now += 60000;
  await manager.tasks.dispatchDue(now);
  await idle();
  expect(manager.tasks.taskRuns(id, a.id).items[0].status).toBe('waiting');
  expect(manager.tasks.taskRuns(id, b.id).items[0]).toMatchObject({
    status: 'queued',
    reason: expect.stringContaining('等待'),
  });
  await manager.tasks.dispatchDue(now);
  expect(decide).toHaveBeenCalledOnce();
  expect(manager.tasks.taskRuns(id, b.id).items).toHaveLength(1);
  expect(
    manager.tasks.taskPlans(id).find((p) => p.id === a.id)?.nextRunAt,
  ).toBe(now + 60000);
});
it('records offline once as missed and recurring as skipped without joining', async () => {
  const id = await role();
  manager.stop(id);
  await vi.waitFor(() => expect(manager.list()[0].status).toBe('stopped'));
  const once = await manager.tasks.createTaskPlan(
    id,
    draft({ kind: 'once', at: now + 60000 }),
  );
  const repeat = await manager.tasks.createTaskPlan(
    id,
    draft({ kind: 'interval', everyMs: 60000 }),
  );
  now += 60000;
  await manager.tasks.dispatchDue(now);
  expect(manager.tasks.taskRuns(id, once.id).items[0].status).toBe('missed');
  expect(manager.tasks.taskRuns(id, repeat.id).items[0].status).toBe('skipped');
  expect(decide).not.toHaveBeenCalled();
  expect(manager.list()[0].sessionId).toBeUndefined();
  await expect(
    manager.tasks.controlTaskPlan(id, once.id, 'run', { requestId: 'offline' }),
  ).rejects.toThrow('离线');
});
it('separates plan pause, run pause, edits and resumption while preserving snapshots and usage', async () => {
  const id = await role();
  decide.mockImplementation(async () => response('waiting'));
  const p = await manager.tasks.createTaskPlan(
    id,
    draft({ kind: 'interval', everyMs: 60000 }),
  );
  await manager.tasks.controlTaskPlan(id, p.id, 'run', { requestId: 'manual' });
  await idle();
  const run = manager.tasks.taskRuns(id, p.id).items[0];
  expect(manager.tasks.taskPlans(id)[0].nextRunAt).toBe(now + 60000);
  await manager.tasks.controlTaskPlan(id, p.id, 'pause');
  expect(manager.tasks.taskRuns(id, p.id).items[0].status).toBe('waiting');
  await manager.tasks.updateTaskPlan(id, p.id, {
    ...draft({ kind: 'interval', everyMs: 120000 }),
    goal: '新的未来目标',
    limits: { ...DEFAULT_TASK_LIMITS, maxTurns: 20 },
  });
  expect(manager.tasks.taskRuns(id, p.id).items[0].snapshot).toEqual(
    run.snapshot,
  );
  await manager.tasks.controlTaskRun(id, run.id, 'pause');
  const other = await manager.tasks.createTaskPlan(id, draft());
  await idle();
  expect(manager.tasks.taskRuns(id, other.id).items[0].status).toBe('queued');
  await manager.tasks.controlTaskRun(
    id,
    manager.tasks.taskRuns(id, other.id).items[0].id,
    'cancel',
  );
  decide.mockImplementation(async () => response());
  await manager.tasks.controlTaskRun(id, run.id, 'resume');
  await idle();
  expect(manager.tasks.taskRuns(id, p.id).items[0]).toMatchObject({
    status: 'completed',
    totalTokens: 1200,
    task: { calls: 2, goal: run.snapshot.goal },
  });
  expect(manager.tasks.taskPlans(id).find((x) => x.id === p.id)?.state).toBe(
    'paused',
  );
  now += 300000;
  await manager.tasks.controlTaskPlan(id, p.id, 'resume');
  expect(
    manager.tasks.taskPlans(id).find((x) => x.id === p.id)!.nextRunAt,
  ).toBeGreaterThan(now);
});
it('enforces per-run and lifetime budgets including manual work, and extension never erases usage', async () => {
  const id = await role();
  decide.mockImplementation(async () => response('running'));
  const p = await manager.tasks.createTaskPlan(id, {
    ...draft({ kind: 'interval', everyMs: 60000 }),
    limits: { ...DEFAULT_TASK_LIMITS, maxTurns: 1 },
    totalTokenBudget: 1000,
  });
  await manager.tasks.controlTaskPlan(id, p.id, 'run', { requestId: 'first' });
  await idle();
  let run = manager.tasks.taskRuns(id, p.id).items[0];
  expect(run.status).toBe('budget');
  expect(manager.tasks.taskPlans(id)[0].state).toBe('paused');
  expect(
    manager.list().find((role) => role.id === id)?.taskExecution,
  ).toMatchObject({
    runId: run.id,
    limits: run.snapshot.limits,
  });
  await expect(
    manager.tasks.controlTaskRun(id, run.id, 'resume'),
  ).rejects.toThrow('额度');
  await manager.tasks.controlTaskRun(id, run.id, 'resume', { maxTurns: 10 });
  await idle();
  run = manager.tasks.taskRuns(id, p.id).items[0];
  expect(run.totalTokens).toBe(1200);
  expect(run.task?.calls).toBe(2);
  expect(
    manager.list().find((role) => role.id === id)?.taskExecution?.limits
      .maxTurns,
  ).toBe(10);
  expect(run.status).toBe('budget');
  await expect(
    manager.tasks.controlTaskRun(id, run.id, 'resume'),
  ).rejects.toThrow('累计额度');
  await manager.tasks.controlTaskPlan(id, p.id, 'extend', { tokens: 1000 });
  expect(manager.tasks.taskPlans(id)[0]).toMatchObject({
    spentTokens: 1200,
    totalTokenBudget: 2000,
    state: 'paused',
  });
  await manager.tasks.controlTaskRun(id, run.id, 'cancel');
  await manager.tasks.controlTaskPlan(id, p.id, 'resume');
  expect(manager.tasks.taskPlans(id)[0].spentTokens).toBe(1200);
});
it('keeps the activity slot after an execution error until explicit resolution', async () => {
  const id = await role();
  const p = await manager.tasks.createTaskPlan(
    id,
    draft({ kind: 'interval', everyMs: 60000 }),
  );
  vi.spyOn(AgentRunner.prototype, 'run').mockRejectedValueOnce(
    new AgentRuntimeError('fixture', true),
  );
  await manager.tasks.controlTaskPlan(id, p.id, 'run', { requestId: 'err' });
  await vi.waitFor(() => expect(manager.list()[0].status).toBe('failed'));
  expect(manager.tasks.taskPlans(id)[0].state).toBe('paused');
  expect(manager.tasks.taskRuns(id, p.id).items[0].status).toBe('failed');
  const pending = await manager.tasks.createTaskPlan(id, draft());
  expect(manager.tasks.taskRuns(id, pending.id).items[0].status).toBe('queued');
  expect(decide).not.toHaveBeenCalled();
});
it('restart preserves paused progress and skips missed schedules without calling a model', async () => {
  const id = await role();
  decide.mockImplementation(async () => response('waiting'));
  const p = await manager.tasks.createTaskPlan(id, draft());
  await idle();
  const r = manager.tasks.taskRuns(id, p.id).items[0];
  const future = await manager.tasks.createTaskPlan(
    id,
    draft({ kind: 'interval', everyMs: 60000 }),
  );
  await manager.close();
  now += 180000;
  manager = build();
  decide.mockClear();
  await manager.load();
  expect(decide).not.toHaveBeenCalled();
  expect(manager.tasks.taskRuns(id, p.id).items[0]).toMatchObject({
    id: r.id,
    status: 'paused',
    totalTokens: 600,
    task: { calls: 1 },
  });
  expect(manager.tasks.taskPlans(id).find((x) => x.id === p.id)?.state).toBe(
    'paused',
  );
  expect(manager.tasks.taskRuns(id, future.id).items[0].status).toBe('skipped');
  await manager.tasks.dispatchDue(now);
  expect(decide).not.toHaveBeenCalled();
});
it('archives only ended runs and paginates independent history', async () => {
  const id = await role();
  const p = await manager.tasks.createTaskPlan(id, draft());
  await idle();
  for (let i = 0; i < 21; i++) {
    await manager.tasks.controlTaskPlan(id, p.id, 'run', {
      requestId: `page-${i}`,
    });
    await idle();
  }
  expect(manager.tasks.taskRuns(id, p.id).items).toHaveLength(20);
  expect(manager.tasks.taskRuns(id, p.id).nextOffset).toBe(20);
  expect(manager.tasks.taskRuns(id, p.id, 20).items).toHaveLength(2);
  await manager.tasks.controlTaskPlan(id, p.id, 'archive');
  expect(manager.tasks.taskPlans(id)[0].state).toBe('archived');
  expect(manager.tasks.taskRuns(id, p.id).items).toHaveLength(20);
});

it('switches plans after a pause without losing the older resumable run', async () => {
  const id = await role();
  decide.mockImplementation(async () => response('waiting'));
  const p = await manager.tasks.createTaskPlan(id, draft());
  await idle();
  const first = manager.tasks.taskRuns(id, p.id).items[0];
  await manager.tasks.controlTaskRun(id, first.id, 'pause');
  decide.mockImplementation(async () => response());
  await expect(
    manager.tasks.controlTaskPlan(id, p.id, 'run', { requestId: 'same-plan' }),
  ).rejects.toThrow('未完成');
  const second = await manager.tasks.createTaskPlan(id, draft());
  await idle();
  expect(manager.tasks.taskRuns(id, p.id).items).toHaveLength(1);
  expect(manager.tasks.taskRuns(id, second.id).items).toHaveLength(1);
  expect(manager.tasks.taskRuns(id, p.id).active[0]).toMatchObject({
    id: first.id,
    status: 'paused',
    totalTokens: 600,
  });
  await expect(
    manager.tasks.controlTaskPlan(id, p.id, 'archive'),
  ).rejects.toThrow('结束');
  await manager.tasks.controlTaskRun(id, first.id, 'resume');
  await idle();
  expect(
    manager.tasks.taskRuns(id, p.id).items.find((r) => r.id === first.id)
      ?.totalTokens,
  ).toBe(1200);
});
it('restores unconfirmed action history as unknown and expires private runs without executing them', async () => {
  const id = await role();
  decide.mockImplementation(async () => response('waiting'));
  const p = await manager.tasks.createTaskPlan(id, draft());
  await idle();
  await manager.close();
  const archive = JSON.parse(store.archive.json!);
  const record = archive.runs[0];
  const previous = {
    actions: [{ type: 'edit', x: 1, y: 3, z: 1, material: 'wood' }],
    results: [
      {
        action: { type: 'edit', x: 1, y: 3, z: 1, material: 'wood' },
        status: 'executing',
      },
    ],
    remaining: [],
    ok: false,
    stopReason: 'executing',
  };
  record.runtime.execution.effects.previous = previous;
  archive.characters[0].runtime.execution.effects.previous = previous;
  record.runtime.execution.task.current.privateTo = 'expired-player';
  archive.characters[0].runtime.execution.task.current.privateTo =
    'expired-player';
  record.runtime.execution.effects.unfinishedBuild = {
    action: { type: 'build', blocks: [{ x: 1, y: 3, z: 1, material: 'wood' }] },
    result: {
      ok: false,
      total: 1,
      completed: 0,
      skipped: 0,
      remaining: [{ x: 1, y: 3, z: 1, material: 'wood' }],
      failures: [],
    },
  };
  archive.characters[0].runtime.execution.effects.unfinishedBuild =
    record.runtime.execution.effects.unfinishedBuild;
  store.archive.json = JSON.stringify(archive);
  manager = build();
  decide.mockClear();
  await manager.load();
  const run = manager.tasks.taskRuns(id, p.id).items[0];
  expect(run.requiresReassignment).toBe(true);
  expect(run.status).toBe('needs_input');
  expect(decide).not.toHaveBeenCalled();
  await expect(
    manager.tasks.controlTaskRun(id, run.id, 'resume'),
  ).rejects.toThrow('私聊');
  const restored = JSON.parse(store.archive.json!);
  expect(
    restored.runs[0].runtime.execution.effects.previous.results[0].status,
  ).toBe('unknown');
  expect(
    restored.runs[0].runtime.execution.effects.unfinishedBuild.result.remaining,
  ).toHaveLength(1);
});

it('records chat execution without creating plans and rejects replacement of active work', async () => {
  const id = await role();
  const addressed = (seq: number): WorldEvent => ({
    seq,
    actor: 'owner',
    actorKind: 'human',
    type: 'chat',
    at: now,
    data: {
      scope: 'private',
      recipients: ['fixture-player'],
      text: '请观察营地',
      kind: 'text',
      name: 'Owner',
    },
  });
  decide.mockImplementation(async () => [
    { name: 'start_task', arguments: { goal: '聊天安排' } },
    {
      name: 'wait_for',
      arguments: { condition: 'world', reason: '观察后等待' },
    },
  ]);
  currentSession.onEvent!(addressed(1));
  await vi.waitFor(() =>
    expect(manager.plans.runs.filter((r) => r.characterId === id)).toHaveLength(
      1,
    ),
  );
  await idle();
  expect(manager.tasks.taskPlans(id)).toHaveLength(0);
  expect(manager.plans.runs[0].planId).toBeUndefined();
  expect(manager.plans.runs[0]).toMatchObject({
    source: 'chat',
    totalTokens: 600,
    task: { privateTo: 'owner' },
  });
  const originalRunId = manager.plans.runs[0].id;
  currentSession.onEvent!(addressed(2));
  await vi.waitFor(() =>
    expect(decide.mock.calls.length).toBeGreaterThanOrEqual(2),
  );
  await idle();
  expect(manager.tasks.taskPlans(id)).toHaveLength(0);
  expect(manager.plans.runs).toHaveLength(1);
  expect(manager.plans.runs[0].task?.goal).toBe('聊天安排');
  expect(manager.plans.runs[0].id).toBe(originalRunId);
  expect(manager.plans.runs[0].task?.owner).toBe('owner');
});

it('unchecked limits survive restart, resume and scheduled/manual executions without capping cumulative usage', async () => {
  const id = await role();
  const p = await manager.tasks.createTaskPlan(id, {
    ...draft({ kind: 'interval', everyMs: 60000 }),
    limits: {
      enabled: false,
      maxTurns: 1,
      tokenBudget: 1000,
      taskTimeoutMs: 60000,
    },
    totalTokenBudget: 1000,
  });
  decide.mockResolvedValueOnce(response('waiting'));
  await manager.tasks.controlTaskPlan(id, p.id, 'run', {
    requestId: 'unlimited-first',
  });
  await idle();
  const r = manager.tasks.taskRuns(id, p.id).items[0];
  expect(r.status).toBe('waiting');
  await manager.tasks.controlTaskRun(id, r.id, 'pause');
  await manager.close();
  manager = build();
  await manager.load();
  await idle();
  expect(manager.tasks.taskPlans(id)[0].limits.enabled).toBe(false);
  await manager.tasks.controlTaskRun(id, r.id, 'resume');
  await idle();
  expect(manager.tasks.taskRuns(id, p.id).items[0]).toMatchObject({
    status: 'completed',
    totalTokens: 1200,
    task: { calls: 2 },
    snapshot: { limits: { enabled: false } },
  });
  await manager.tasks.controlTaskPlan(id, p.id, 'run', {
    requestId: 'unlimited-again',
  });
  await idle();
  now += 60000;
  await manager.tasks.dispatchDue(now);
  await idle();
  expect(manager.tasks.taskPlans(id)[0]).toMatchObject({
    state: 'enabled',
    spentTokens: 2400,
  });
  expect(manager.tasks.taskRuns(id, p.id).items).toHaveLength(3);
});

it('persists an independently disabled plan total while retaining per-run limits', async () => {
  const id = await role();
  const p = await manager.tasks.createTaskPlan(id, {
    ...draft({ kind: 'interval', everyMs: 60000 }),
    totalTokenBudget: 1000,
    totalTokenBudgetEnabled: false,
  });
  await manager.tasks.controlTaskPlan(id, p.id, 'run', {
    requestId: 'first-without-total',
  });
  await idle();
  await manager.tasks.controlTaskPlan(id, p.id, 'run', {
    requestId: 'second-without-total',
  });
  await idle();
  expect(manager.tasks.taskPlans(id)[0]).toMatchObject({
    state: 'enabled',
    spentTokens: 1200,
    totalTokenBudgetEnabled: false,
    limits: { enabled: true },
  });
  await manager.close();
  manager = build();
  await manager.load();
  await idle();
  expect(manager.tasks.taskPlans(id)[0].totalTokenBudgetEnabled).toBe(false);
  await manager.tasks.updateTaskPlan(id, p.id, {
    totalTokenBudgetEnabled: true,
  });
  await expect(
    manager.tasks.controlTaskPlan(id, p.id, 'run', {
      requestId: 'third-with-total',
    }),
  ).rejects.toThrow('累计额度');
});

it('retains multiple Pi tool batches within the same model call in actual action history', async () => {
  await manager.close();
  manager = new AICharacterManager(store, 'ws://fixture', store.archive, {
    session: () => {
      const s = session();
      s.observe = async () => ({
        id: 'o',
        revision: 1,
        radius: 8,
        self: {
          id: 'fixture-player',
          name: 'AI',
          kind: 'ai-agent',
          connected: true,
          x: 0,
          y: 2.5,
          z: 0,
          yaw: 0,
        },
        players: [],
        blocks: [],
        events: [],
        allowedActions: [],
      });
      return s as unknown as Session;
    },
    model: () => ({
      endpoint: undefined,
      request: async () =>
        toolResponse([
          { name: 'chat', arguments: { text: '完成' } },
          {
            name: 'complete_task',
            arguments: {
              summary: '完成',
            },
          },
        ]),
    }),
  });
  const id = await role();
  const plan = await manager.tasks.createTaskPlan(id, {
    ...draft(),
    requestId: 'pi-batches',
  });
  await idle();
  const history = manager.tasks.taskRuns(id, plan.id).items;
  expect(history[0].actions?.map((a) => a.kind)).toEqual(['chat']);
  expect(new Set(history[0].actions?.map((a) => a.batchId)).size).toBe(1);
});

it('owns plans independently, reassigns with revision guards and retains executor snapshots', async () => {
  const a = await role(),
    b = await role();
  const p = await manager.tasks.createTaskPlan(a, draft());
  await vi.waitFor(() =>
    expect(manager.tasks.taskRuns(a, p.id).items[0].status).toBe('completed'),
  );
  const first = manager.tasks.taskRuns(a, p.id).items[0];
  const before = manager.tasks.publicPlan(p.id);
  const result = await manager.tasks.reassignPlan(p.id, b, {
    expectedPlanRevision: before.revision,
  });
  expect(result).toMatchObject({
    characterId: b,
    state: 'paused',
    spentTokens: 600,
  });
  expect(manager.tasks.publicRuns(undefined, p.id).items[0]).toMatchObject({
    id: first.id,
    characterId: a,
    planRevision: 1,
    totalTokens: 600,
  });
  expect(manager.tasks.taskPlans(a)).toHaveLength(0);
  await expect(
    manager.tasks.controlTaskPlan(undefined, p.id, 'pause', {
      expectedPlanRevision: before.revision,
    }),
  ).rejects.toThrow('已改变');
  await expect(
    manager.tasks.controlTaskPlan(a, p.id, 'pause', {}),
  ).rejects.toThrow('已改变');
  const page = await manager.tasks.planPage({});
  expect(page.items).toHaveLength(1);
  expect(page.items[0].characterId).toBe(b);
  await manager.tasks.controlTaskPlan(b, p.id, 'run', {
    requestId: 'new-owner',
  });
  await vi.waitFor(() =>
    expect(manager.tasks.publicPlan(p.id).spentTokens).toBe(1200),
  );
  expect(manager.tasks.publicPlan(p.id).state).toBe('paused');
});

it('deletes an Agent without deleting plans or history and restores unassigned plans', async () => {
  const a = await role();
  decide.mockImplementation(async () => response('waiting'));
  const p = await manager.tasks.createTaskPlan(
    a,
    draft({ kind: 'interval', everyMs: 60000 }),
  );
  await manager.tasks.controlTaskPlan(a, p.id, 'run', {
    requestId: 'wait-delete',
  });
  await idle();
  const run = manager.tasks.taskRuns(a, p.id).items[0];
  await expect(manager.tasks.reassignPlan(p.id, a)).rejects.toThrow('未结束');
  await manager.remove(a);
  expect(manager.list()).toHaveLength(0);
  expect(manager.tasks.publicPlan(p.id)).toMatchObject({
    state: 'paused',
    spentTokens: 600,
  });
  expect(manager.tasks.publicPlan(p.id).characterId).toBeUndefined();
  expect(manager.tasks.publicRuns(undefined, p.id).items[0]).toMatchObject({
    id: run.id,
    status: 'cancelled',
    characterId: a,
    totalTokens: 600,
  });
  await manager.close();
  manager = build();
  await manager.load();
  expect(manager.tasks.publicPlan(p.id).characterId).toBeUndefined();
  expect(manager.tasks.publicRuns(undefined, p.id).items[0].status).toBe(
    'cancelled',
  );
  const b = await role();
  await manager.tasks.reassignPlan(p.id, b);
  expect(manager.tasks.publicPlan(p.id)).toMatchObject({
    characterId: b,
    state: 'paused',
    spentTokens: 600,
  });
});

it('does not publish an uncommitted reassignment or lose other plans on save failure', async () => {
  const a = await role(),
    b = await role();
  const p = await manager.tasks.createTaskPlan(
    a,
    draft({ kind: 'interval', everyMs: 60000 }),
  );
  const before = manager.tasks.publicPlan(p.id);
  store.archive.saveError = new Error('fixture storage failure');
  try {
    await expect(manager.tasks.reassignPlan(p.id, b)).rejects.toThrow();
    expect(manager.tasks.publicPlan(p.id)).toEqual(before);
    expect(manager.plans.get(p.id).characterId).toBe(a);
  } finally {
    store.archive.saveError = undefined;
  }
});

it('filters global plans and controls plan state independently of a chat task revision', async () => {
  const a = await role();
  const p = await manager.tasks.createTaskPlan(a, {
    ...draft({ kind: 'daily', time: '09:00' }),
    name: '每天巡查',
  });
  await manager.tasks.controlTaskPlan(undefined, p.id, 'pause', {
    expectedPlanRevision: p.revision,
  });
  const result = await manager.tasks.planPage({
    search: '巡查',
    state: 'paused',
    timing: 'daily',
    characterId: a,
  });
  expect(result.items).toHaveLength(1);
  const none = await manager.tasks.planPage({
    search: '不存在',
  });
  expect(none.total).toBe(0);
});

it('keeps newer plan definitions intact when an older execution completes', async () => {
  const id = await role();
  decide.mockImplementation(async () => response('waiting'));
  const plan = await manager.tasks.createTaskPlan(id, draft());
  await idle();
  const run = manager.tasks.taskRuns(id, plan.id).items[0];
  await manager.tasks.updateTaskPlan(id, plan.id, {
    ...draft(),
    goal: '下一次目标',
  });
  const revision = manager.tasks.taskPlans(id)[0].revision;
  await manager.tasks.controlTaskRun(id, run.id, 'pause');
  decide.mockImplementation(async () => response());
  await manager.tasks.controlTaskRun(id, run.id, 'resume');
  await idle();
  expect(manager.tasks.taskRuns(id, plan.id).items[0]).toMatchObject({
    status: 'completed',
    snapshot: { goal: plan.goal },
  });
  expect(manager.tasks.taskPlans(id)[0]).toMatchObject({
    goal: '下一次目标',
    state: 'enabled',
    revision,
  });
  expect(manager.tasks.taskPlans(id)[0].spentTokens).toBe(1200);
});

it('rolls back deletion of the Agent, bindings and history together when storage fails', async () => {
  const id = await role();
  const plan = await manager.tasks.createTaskPlan(id, draft());
  await idle();
  const history = manager.tasks.publicRuns(undefined, plan.id);
  store.archive.saveError = new Error('fixture storage failure');
  try {
    await expect(manager.remove(id)).rejects.toThrow();
    expect(manager.list().some((a) => a.id === id)).toBe(true);
    expect(manager.plans.get(plan.id).characterId).toBe(id);
    expect(manager.tasks.publicPlan(plan.id).characterId).toBe(id);
    expect(manager.tasks.publicRuns(undefined, plan.id).items).toEqual(
      history.items,
    );
  } finally {
    store.archive.saveError = undefined;
  }
});

it('freezes each executor name at launch while showing the live role name on plans', async () => {
  const id = await role();
  const plan = await manager.tasks.createTaskPlan(id, draft());
  await idle();
  const first = manager.tasks.publicRuns(undefined, plan.id).items[0];
  await manager.update(id, { name: '改名后的角色' });
  expect(manager.tasks.publicPlan(plan.id).characterName).toBe('改名后的角色');
  await manager.tasks.controlTaskPlan(id, plan.id, 'run', {
    requestId: 'after-rename',
  });
  await idle();
  const runs = manager.tasks.publicRuns(undefined, plan.id).items;
  expect(runs[0].characterName).toBe('改名后的角色');
  expect(runs[1].characterName).toBe(first.characterName);
  await manager.remove(id);
  expect(manager.tasks.publicPlan(plan.id).characterName).toBe('改名后的角色');
  expect(
    manager.tasks.publicRuns(undefined, plan.id).items[1].characterName,
  ).toBe(first.characterName);
});

it('preserves plan execution when changing models and rejects implicit task replacement', async () => {
  const id = await role();
  decide.mockImplementation(async () => response('waiting'));
  const plan = await manager.tasks.createTaskPlan(id, draft());
  await idle();
  const before = manager.tasks.publicRuns(undefined, plan.id).items[0];
  const calls = decide.mock.calls.length;
  await manager.update(id, { model: 'deepseek-reasoner' });
  const after = manager.tasks.publicRuns(undefined, plan.id).items[0];
  expect(after).toMatchObject({
    id: before.id,
    source: 'manual',
    status: 'paused',
    totalTokens: before.totalTokens,
    task: { goal: before.task!.goal, calls: before.task!.calls },
  });
  expect(manager.plans.plans).toHaveLength(1);
  expect(manager.plans.runs).toHaveLength(1);
  expect(decide).toHaveBeenCalledTimes(calls);
  const previous = structuredClone(manager.list());
  await expect(
    manager.update(id, { goal: '兼容入口的新目标' }),
  ).rejects.toThrow('Tasks');
  expect(manager.list()).toEqual(previous);
  expect(manager.plans.plans).toHaveLength(1);
  expect(manager.plans.runs).toHaveLength(1);
  expect(
    manager.plans.runs.every((run) => run.planId && run.source === 'manual'),
  ).toBe(true);
  expect(manager.tasks.publicRuns(undefined, plan.id).items[0]).toMatchObject({
    id: before.id,
    status: 'paused',
    totalTokens: before.totalTokens,
  });
  expect(decide).toHaveBeenCalledTimes(calls);
});

it('coalesces queued triggers and keeps a paused activity ahead of queued work', async () => {
  const id = await role();
  decide.mockImplementation(async () => response('waiting'));
  const active = await manager.tasks.createTaskPlan(id, draft());
  await idle();
  const activeRun = manager.tasks.taskRuns(id, active.id).items[0];
  await manager.tasks.controlTaskRun(id, activeRun.id, 'pause');
  const pending = await manager.tasks.createTaskPlan(
    id,
    draft({ kind: 'interval', everyMs: 60000 }),
  );
  now += 60000;
  await manager.tasks.dispatchDue(now);
  now += 60000;
  await manager.tasks.dispatchDue(now);
  const queued = manager.tasks.taskRuns(id, pending.id).items;
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({
    status: 'queued',
    coalescedTriggers: 1,
    totalTokens: 0,
  });
  expect(queued[0].task).toBeUndefined();
  expect(manager.list()[0].task?.status).toBe('paused');
  await expect(
    manager.tasks.controlTaskRun(id, queued[0].id, 'resume'),
  ).rejects.toThrow('排队');
  expect(decide).toHaveBeenCalledOnce();
  await manager.tasks.controlTaskRun(id, activeRun.id, 'cancel');
  await manager.tasks.dispatchDue(now);
  await idle();
  expect(manager.tasks.taskRuns(id, pending.id).items[0]).toMatchObject({
    id: queued[0].id,
    status: 'waiting',
  });
  expect(decide).toHaveBeenCalledTimes(2);
});

it('cancels queued work on plan pause without starting it', async () => {
  const id = await role();
  decide.mockImplementation(async () => response('waiting'));
  await manager.tasks.createTaskPlan(id, draft());
  await idle();
  const p = await manager.tasks.createTaskPlan(id, draft());
  expect(manager.tasks.taskRuns(id, p.id).items[0].status).toBe('queued');
  await manager.tasks.controlTaskPlan(id, p.id, 'pause');
  expect(manager.tasks.taskRuns(id, p.id).items[0]).toMatchObject({
    status: 'cancelled',
    totalTokens: 0,
  });
  expect(decide).toHaveBeenCalledOnce();
});

it('freezes inherited limits at execution start without overwriting role defaults', async () => {
  const id = await role();
  await manager.update(id, {
    maxTurns: 17,
    tokenBudget: 80000,
    maxStalledTurns: 7,
  });
  const p = await manager.tasks.createTaskPlan(id, {
    ...draft({ kind: 'once', at: now + 60000 }),
    limitsMode: 'inherit',
  });
  await manager.update(id, { maxTurns: 23 });
  now += 60000;
  await manager.tasks.dispatchDue(now);
  await idle();
  expect(
    manager.tasks.taskRuns(id, p.id).items[0].snapshot.limits,
  ).toMatchObject({ maxTurns: 23, tokenBudget: 80000, maxStalledTurns: 7 });
  const other = await manager.tasks.createTaskPlan(id, {
    ...draft(),
    limitsMode: 'override',
    limits: { ...DEFAULT_TASK_LIMITS, maxTurns: 2, maxStalledTurns: 9 },
  });
  await idle();
  expect(
    manager.tasks.taskRuns(id, other.id).items[0].snapshot.limits.maxTurns,
  ).toBe(2);
  expect(
    manager.tasks.taskRuns(id, other.id).items[0].snapshot.limits
      .maxStalledTurns,
  ).toBe(9);
  expect(manager.list()[0].maxStalledTurns).toBe(7);
  expect(manager.list()[0].maxTurns).toBe(23);
});

it('restores queued IDs and coalesced triggers without spending or replacing a paused task', async () => {
  const id = await role();
  decide.mockImplementation(async () => response('waiting'));
  const active = await manager.tasks.createTaskPlan(id, draft());
  await idle();
  const pending = await manager.tasks.createTaskPlan(
    id,
    draft({ kind: 'interval', everyMs: 60000 }),
  );
  now += 60000;
  await manager.tasks.dispatchDue(now);
  now += 60000;
  await manager.tasks.dispatchDue(now);
  const queued = manager.tasks.taskRuns(id, pending.id).items[0];
  // Re-delivery of an older coalesced trigger must not increment the count.
  manager.plans.get(pending.id).nextRunAt = queued.scheduledAt;
  await manager.tasks.dispatchDue(now);
  expect(
    manager.tasks.taskRuns(id, pending.id).items[0].coalescedTriggers,
  ).toBe(1);
  const usage = manager.list()[0].usage;
  const activeId = manager.tasks.taskRuns(id, active.id).items[0].id;
  await manager.close();
  manager = build();
  await manager.load();
  expect(manager.tasks.taskRuns(id, pending.id).items[0]).toMatchObject({
    id: queued.id,
    status: 'queued',
    coalescedTriggers: 1,
    totalTokens: 0,
  });
  expect(manager.list()[0].usage).toEqual(usage);
  expect(manager.tasks.taskRuns(id, active.id).items[0]).toMatchObject({
    id: activeId,
    status: 'paused',
  });
  expect(decide).toHaveBeenCalledOnce();
});

it('saves plan configuration and character reassignment together', async () => {
  const a = await role(),
    b = await role();
  const p = await manager.tasks.createTaskPlan(
    a,
    draft({ kind: 'interval', everyMs: 60000 }),
  );
  const saved = await manager.tasks.updateTaskPlan(a, p.id, {
    name: '新的安排',
    targetCharacterId: b,
  });
  expect(saved).toMatchObject({
    name: '新的安排',
    characterId: b,
    state: 'paused',
  });
  expect(saved.nextRunAt).toBeUndefined();
  expect(manager.tasks.publicPlan(p.id)).toMatchObject({
    name: '新的安排',
    characterId: b,
  });
});

it('rejects combined reassignment while a run is unfinished without saving edits', async () => {
  const a = await role(),
    b = await role();
  decide.mockImplementation(async () => response('waiting'));
  const p = await manager.tasks.createTaskPlan(a, draft());
  await idle();
  await expect(
    manager.tasks.updateTaskPlan(a, p.id, {
      name: '不应保存',
      targetCharacterId: b,
    }),
  ).rejects.toThrow('未结束');
  expect(manager.plans.get(p.id)).toMatchObject({
    name: p.name,
    characterId: a,
  });
});
