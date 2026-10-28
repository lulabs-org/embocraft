import {
  emptyState,
  newTask,
  restoreCheckpoint,
  restoreState,
  TaskService,
  type AgentRunState,
} from '@voxel/agent-runtime';
import { describe, expect, it } from 'vitest';
import { RequestBudget } from '../../../packages/agent-runtime/src/agent/task/budget';
import { testAgentConfig } from '../../../tests/support/agent-config';
import { bootstrapProviders } from '../src/modules/providers';
import { migrateArchive } from '../src/persistence/migrate-archive';
import { MemoryProviderRepository } from './helpers/memory-storage';
const config = testAgentConfig();
const operator = { kind: 'operator' as const };

describe('TaskService revision and commit boundary', () => {
  it('retains identity, costs and unknown effects when revising, but invalidates old results', () => {
    const memory: AgentRunState = {
      ...emptyState(),
      task: {
        current: newTask('old'),
        usage: { calls: 2, tokens: 400, estimated: false },
      },
      checkpoint: {
        unknownEffect: { id: 'effect', name: 'chat', state: 'unknown' },
      },
    };
    Object.assign(memory.task.current!, {
      calls: 2,
      tokens: 400,
      elapsedMs: 500,
    });
    const service = new TaskService(memory),
      lease = service.lease();
    memory.effects.follow = {
      action: { type: 'follow', playerId: 'human', distance: 1 },
      taskStartedAt: memory.task.current!.startedAt,
      pursuing: true,
    };
    service.command({ type: 'revise', goal: 'new' }, operator, config);
    expect(service.lease()).toMatchObject({
      id: lease.id,
      revision: lease.revision + 1,
    });
    expect(memory.task.current).toMatchObject({
      goal: 'new',
      calls: 2,
      tokens: 400,
      elapsedMs: 500,
    });
    expect(memory.effects.follow).toBeUndefined();
    expect(memory.checkpoint.unknownEffect).toBeDefined();
    expect(() =>
      service.finish(lease, { status: 'completed', reason: 'late' }),
    ).toThrow('过期');
  });
  it('rolls back a rejected durable command without losing provider usage', async () => {
    const memory: AgentRunState = {
      ...emptyState(),
      task: {
        current: newTask('old'),
        usage: { calls: 0, tokens: 0, estimated: false },
      },
    };
    const before = structuredClone(memory.task.current);
    const budget = new RequestBudget(config, memory.task.usage!);
    budget.begin();
    budget.finish(100, false);
    await expect(
      new TaskService(memory).commit(
        { type: 'revise', goal: 'new' },
        operator,
        config,
        async () => {
          throw Error('disk');
        },
        budget,
      ),
    ).rejects.toThrow('检查点');
    expect(memory.task.current).toEqual(before);
    expect(memory.task.usage).toMatchObject({ calls: 1, tokens: 100 });
  });
  it('checks a completion independently of model prose', () => {
    const memory: AgentRunState = {
      ...emptyState(),
      task: { current: newTask('work') },
    };
    const service = new TaskService(memory),
      lease = service.lease();
    expect(() =>
      service.finish(lease, { status: 'completed', reason: 'done' }, true),
    ).toThrow('未确认');
    memory.checkpoint.unknownEffect = {
      id: 'unknown',
      name: 'goto',
      state: 'unknown',
    };
    expect(() =>
      service.finish(lease, { status: 'completed', reason: 'done' }),
    ).toThrow('未确认');
  });
});

it('migrates current and historical runtimes while preserving uncertain effects and budgets', async () => {
  const providers = new MemoryProviderRepository();

  await bootstrapProviders(providers);

  const task = { ...newTask('old build'), calls: 3, tokens: 600 };

  task.status = 'completed';

  // Persisted v2 archives are flat; restoreState is the only migration entry.
  const legacyRuntime = {
    task,
    pi: {
      version: 1,
      taskStartedAt: task.startedAt,
      audience: 'public',
      messages: [],
      inFlight: { id: 'old-chat', name: 'chat', state: 'executing' },
    },
  } as unknown as AgentRunState;

  const record = {
    ...config,
    providerId: 'deepseek',
    id: 'old-agent',
    status: 'stopped',
    createdAt: task.startedAt,
    logs: [],
    runtime: legacyRuntime,
    taskBook: {
      version: 1,
      plans: [
        {
          id: 'old-plan',
          name: 'old build',
          goal: 'old build',
          timing: { kind: 'immediate' },
          state: 'completed',
          revision: 1,
          spentTokens: 600,
          limits: {},
          totalTokenBudget: 500000,
        },
      ],
      runs: [
        {
          id: 'old-run',
          planId: 'old-plan',
          status: 'completed',
          runtime: structuredClone(legacyRuntime),
          snapshot: { limits: {}, timing: { kind: 'immediate' } },
          accountedTokens: 600,
          totalTokens: 600,
          logs: [],
        },
      ],
    },
  };

  // Keep the current run ended to avoid fabricating another plan during restore.
  const saved = migrateArchive(JSON.parse(JSON.stringify([record])));

  // The archive reader is deliberately lossless; migration belongs to restoration.
  const migrated = saved!.characters[0];

  migrated.runtime = restoreState(migrated.runtime);

  restoreCheckpoint(migrated.runtime!);

  for (const run of saved!.runs) {
    run.runtime = restoreState(run.runtime);
    restoreCheckpoint(run.runtime!);
  }

  expect(migrated.runtime).toMatchObject({
    version: 3,
    task: { current: { calls: 3, tokens: 600 } },
    checkpoint: { unknownEffect: { name: 'chat', state: 'unknown' } },
  });

  expect(migrated.runtime!.checkpoint.pi).toBeUndefined();

  expect(saved!.runs[0].runtime).toMatchObject({
    version: 3,
    checkpoint: { unknownEffect: { name: 'chat' } },
  });

  const again = structuredClone(migrated.runtime);

  restoreCheckpoint(again!);

  expect(again).toEqual(migrated.runtime);
});

it('counts overlapping activity model/action time once and excludes a later paused interval', async () => {
  const { vi } = await import('vitest');
  let now = 1000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const task = newTask('building');
    const total = { calls: 0, tokens: 0, estimated: false };
    const action = new RequestBudget(config, total, task);
    now = 1100;
    action.flushTime();
    const question = new RequestBudget(config, total);
    now = 1200;
    question.flushTime();
    action.flushTime();
    question.attach(task);
    now = 1300;
    question.flushTime();
    action.flushTime();
    expect(task.elapsedMs).toBe(300);
    now = 10000;
    const resumed = new RequestBudget(config, total, task);
    now = 10100;
    resumed.flushTime();
    expect(task.elapsedMs).toBe(400);
  } finally {
    clock.mockRestore();
  }
});
