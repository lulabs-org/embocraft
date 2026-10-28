import { describe, expect, it } from 'vitest';
import { emptyState } from '../../contracts/state';
import { characterState, taskExecutionState } from '../state/ownership';
import { testAgentConfig } from '../../../../../tests/support/agent-config';
import { TaskPolicy } from './policy';
import { TaskService } from './service';
import { newTask } from './state';

const operator = { kind: 'operator' as const };
const config = testAgentConfig();

function previousState() {
  const state = emptyState();
  state.task.current = { ...newTask('old'), status: 'cancelled' };
  state.task.usage = { calls: 7, tokens: 700, estimated: false };
  state.conversation = {
    exchanges: { public: ['hello'], alice: ['private'] },
    lastChatAt: 123,
    audienceExpired: true,
  };
  state.inbox = {
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
  state.checkpoint.unknownEffect = {
    id: 'old-effect',
    name: 'chat',
    state: 'unknown',
  };
  state.effects.follow = {
    action: { type: 'follow', playerId: 'alice', distance: 1 },
    taskStartedAt: state.task.current.startedAt,
    pursuing: false,
  };
  state.health.failures = 2;
  return state;
}

describe('task execution lifecycle', () => {
  it('retains live partition references while leasing and controlling an existing execution', () => {
    const memory = previousState();
    memory.task.current!.status = 'running';
    delete memory.conversation.audienceExpired;
    const task = memory.task;
    const conversation = memory.conversation;
    const service = new TaskService(memory);
    service.lease();
    service.command({ type: 'pause' }, operator, config);
    service.command({ type: 'resume' }, operator, config);
    expect(memory.task).toBe(task);
    expect(memory.conversation).toBe(conversation);
    expect(task.current?.status).toBe('running');
  });

  it('starts a new execution without replacing the character, its usage, conversations or mailbox', () => {
    const memory = previousState();
    const service = new TaskService(memory);
    const character = characterState(memory);
    const before = structuredClone(character);
    const oldLease = service.lease();

    service.command({ type: 'start', goal: 'new' }, operator, config);

    expect(service.memory).toBe(memory);
    expect(characterState(memory)).toEqual(before);
    expect(memory.task.usage).toBe(character.usage);
    expect(memory.conversation.exchanges).toBe(
      character.conversation.exchanges,
    );
    expect(memory.inbox).toBe(character.inbox);
    expect(memory.task.current).toMatchObject({
      goal: 'new',
      calls: 0,
      tokens: 0,
    });
    expect(memory.conversation.audienceExpired).toBeUndefined();
    expect(memory.checkpoint).toEqual({});
    expect(memory.effects).toEqual({});
    expect(memory.health).toEqual({});
    expect(service.current(oldLease)).toBe(false);
  });

  it('runs task rules with only execution state and retains progress on pause/resume', () => {
    const policy = new TaskPolicy(taskExecutionState(emptyState()));
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
    const usage = memory.task.usage!;

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
          memory.conversation.exchanges!.public.push('uncommitted');
          memory.inbox!.events[0].state = 'done';
          usage.calls++;
          usage.tokens += 100;
        },
      ),
    ).rejects.toThrow('检查点');

    expect(service.memory).toBe(memory);
    expect(memory).toEqual({ ...before, task: { ...before.task, usage } });
    expect(memory.task.usage).toBe(usage);
    expect(usage).toMatchObject({ calls: 8, tokens: 800 });
  });
});
