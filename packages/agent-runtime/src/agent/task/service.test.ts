import { describe, expect, it } from 'vitest';
import { testAgentConfig } from '../../../../../tests/support/agent-config';
import { emptyState } from '../../contracts/state';
import { TaskPolicy } from './policy';
import { TaskService } from './service';
import { newTask } from './state';

const operator = { kind: 'operator' as const };
const config = testAgentConfig();

function previousState() {
  const state = emptyState();
  state.execution.task.current = { ...newTask('old'), status: 'cancelled' };
  state.character.usage = { calls: 7, tokens: 700, estimated: false };
  state.character.conversation = {
    exchanges: { public: ['hello'], alice: ['private'] },
    lastChatAt: 123,
  };
  state.execution.conversation.audienceExpired = true;
  state.character.inbox = {
    version: 1,
    events: [
      {
        id: 'next-message',
        kind: 'chat',
        state: 'pending',
        at: 123,
        audience: 'alice',
      },
    ],
  };
  state.execution.checkpoint.unknownEffect = {
    id: 'old-effect',
    name: 'chat',
    state: 'unknown',
  };
  state.execution.effects.follow = {
    action: { type: 'follow', playerId: 'alice', distance: 1 },
    taskStartedAt: state.execution.task.current.startedAt,
    pursuing: false,
  };
  state.execution.health.failures = 2;
  return state;
}

describe('task execution lifecycle', () => {
  it('retains live partition references while leasing and controlling an existing execution', () => {
    const memory = previousState();
    memory.execution.task.current!.status = 'running';
    delete memory.execution.conversation.audienceExpired;
    const task = memory.execution.task;
    const conversation = memory.execution.conversation;
    const service = new TaskService(memory);
    service.lease();
    service.command({ type: 'pause' }, operator, config);
    service.command({ type: 'resume' }, operator, config);
    expect(memory.execution.task).toBe(task);
    expect(memory.execution.conversation).toBe(conversation);
    expect(task.current?.status).toBe('running');
  });

  it('starts a new execution without replacing the character, its usage, conversations or mailbox', () => {
    const memory = previousState();
    const service = new TaskService(memory);
    const character = memory.character;
    const before = structuredClone(character);
    const oldLease = service.lease();

    service.command({ type: 'start', goal: 'new' }, operator, config);

    expect(service.memory).toBe(memory);
    expect(memory.character).toEqual(before);
    expect(memory.character.usage).toBe(character.usage);
    expect(memory.character.conversation.exchanges).toBe(
      character.conversation.exchanges,
    );
    expect(memory.character.inbox).toBe(character.inbox);
    expect(memory.execution.task.current).toMatchObject({
      goal: 'new',
      calls: 0,
      tokens: 0,
    });
    expect(memory.execution.conversation.audienceExpired).toBeUndefined();
    expect(memory.execution.checkpoint).toEqual({});
    expect(memory.execution.effects).toEqual({});
    expect(memory.execution.health).toEqual({});
    expect(service.current(oldLease)).toBe(false);
  });

  it('runs task rules with only execution state and retains progress on pause/resume', () => {
    const policy = new TaskPolicy(emptyState().execution);
    policy.command({ type: 'start', goal: 'follow' }, operator, config);
    const lease = policy.lease();
    policy.memory.task.current!.tokens = 123;
    policy.memory.effects.follow = {
      action: { type: 'follow', playerId: 'alice', distance: 1 },
      taskStartedAt: lease.startedAt,
      pursuing: true,
    };
    policy.command({ type: 'pause' }, operator, config);
    expect(policy.memory.effects.follow).toBeDefined();
    policy.command({ type: 'resume' }, operator, config);
    expect(policy.memory.task.current).toMatchObject({
      status: 'running',
      tokens: 123,
    });
    expect(policy.lease()).toMatchObject({
      id: lease.id,
      revision: lease.revision + 2,
    });
    expect(() => policy.assertCurrent(lease)).toThrow('过期');
  });

  it('rolls back failed start hooks in both scopes while retaining actual provider charges', async () => {
    const memory = previousState();
    const service = new TaskService(memory);
    service.lease();
    const before = structuredClone(memory);
    const usage = memory.character.usage!;

    await expect(
      service.commit(
        { type: 'start', goal: 'new' },
        operator,
        config,
        async () => {
          throw Error('disk');
        },
        undefined,
        async (_task, previous) => {
          expect(previous).toEqual(before);
          memory.character.conversation.exchanges!.public.push('uncommitted');
          memory.character.inbox!.events[0].state = 'done';
          usage.calls++;
          usage.tokens += 100;
        },
      ),
    ).rejects.toThrow('检查点');

    expect(service.memory).toBe(memory);
    expect(memory).toEqual({
      version: 4,
      character: { ...before.character, usage },
      execution: { ...before.execution, task: { ...before.execution.task } },
    });
    expect(memory.character.usage).toBe(usage);
    expect(usage).toMatchObject({ calls: 8, tokens: 800 });
  });
});
