import { type RuntimeState } from '@voxel/agent-runtime';
import { TaskService } from '../src/agent/task/service';
import { newTask } from '../src/agent/task/state';
import { emptyState } from '../src/contracts/state';

import { describe, expect, it } from 'vitest';
import { testAgentConfig } from '../../../tests/support/agent-config';
import { RequestBudget } from '../src/agent/task/budget';

const config = testAgentConfig();
const operator = { kind: 'operator' as const };

describe('TaskService revision and commit boundary', () => {
  it('retains identity, costs and unknown effects when revising, but invalidates old results', () => {
    const memory: RuntimeState = {
      version: 4 as const,
      character: {
        ...emptyState().character,
        usage: { calls: 2, tokens: 400, estimated: false },
      },
      execution: {
        ...emptyState().execution,
        task: { current: newTask('old') },
        checkpoint: {
          unknownEffect: { id: 'effect', name: 'chat', state: 'unknown' },
        },
      },
    };
    Object.assign(memory.execution.task.current!, {
      calls: 2,
      tokens: 400,
      elapsedMs: 500,
    });
    const service = new TaskService(memory),
      lease = service.lease();
    memory.execution.effects.follow = {
      action: { type: 'follow', playerId: 'human', distance: 1 },
      taskStartedAt: memory.execution.task.current!.startedAt,
      pursuing: true,
    };
    service.command({ type: 'revise', goal: 'new' }, operator, config);
    expect(service.lease()).toMatchObject({
      id: lease.id,
      revision: lease.revision + 1,
    });
    expect(memory.execution.task.current).toMatchObject({
      goal: 'new',
      calls: 2,
      tokens: 400,
      elapsedMs: 500,
    });
    expect(memory.execution.effects.follow).toBeUndefined();
    expect(memory.execution.checkpoint.unknownEffect).toBeDefined();
    expect(() =>
      service.finish(lease, { status: 'completed', reason: 'late' }),
    ).toThrow('过期');
  });
  it('rolls back a rejected durable command without losing provider usage', async () => {
    const memory: RuntimeState = {
      version: 4 as const,
      character: {
        ...emptyState().character,
        usage: { calls: 0, tokens: 0, estimated: false },
      },
      execution: {
        ...emptyState().execution,
        task: { current: newTask('old') },
      },
    };
    const before = structuredClone(memory.execution.task.current);
    const budget = new RequestBudget(config, memory.character.usage!);
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
    expect(memory.execution.task.current).toEqual(before);
    expect(memory.character.usage).toMatchObject({ calls: 1, tokens: 100 });
  });
  it('checks a completion independently of model prose', () => {
    const memory: RuntimeState = {
      version: 4 as const,
      character: { ...emptyState().character },
      execution: {
        ...emptyState().execution,
        task: { current: newTask('work') },
      },
    };
    const service = new TaskService(memory),
      lease = service.lease();
    expect(() =>
      service.finish(lease, { status: 'completed', reason: 'done' }, true),
    ).toThrow('未确认');
    memory.execution.checkpoint.unknownEffect = {
      id: 'unknown',
      name: 'goto',
      state: 'unknown',
    };
    expect(() =>
      service.finish(lease, { status: 'completed', reason: 'done' }),
    ).toThrow('未确认');
  });
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
