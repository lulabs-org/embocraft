import { describe, expect, it } from 'vitest';
import { testAgentConfig } from '../../../../tests/support/agent-config';
import { newTask } from '../agent/task/state';
import { emptyState } from '../contracts/state';
import { createAgentRuntime } from './runtime';

const plan = {
  runId: 'run',
  planId: 'plan',
  characterId: 'character',
  at: 123,
  goal: 'build',
};

describe('host execution boundary', () => {
  it('binds a queued plan exactly once without charging until it starts', () => {
    const runtime = createAgentRuntime();
    const eventId = runtime.queuePlan({ ...plan, revision: 4 });
    expect(runtime.queuePlan({ ...plan, revision: 4 })).toBe(eventId);
    expect(runtime.view().task).toBeUndefined();
    expect(runtime.view().usage).toBeUndefined();
    expect(runtime.snapshot().character.inbox?.events).toHaveLength(1);
    runtime.startScheduled({ ...plan, eventId });
    expect(runtime.snapshot().character.inbox?.events).toHaveLength(1);
    expect(runtime.snapshot().character.inbox?.events[0]).toMatchObject({
      taskId: runtime.view().identity?.id,
      revision: 0,
      runId: plan.runId,
      planId: plan.planId,
    });
  });

  it('exposes detached views and archives while retaining character usage across execution switches', () => {
    const state = emptyState();
    state.character.usage = { calls: 10, tokens: 1000, estimated: false };
    const runtime = createAgentRuntime({ state });
    runtime.startScheduled(plan);
    const view = runtime.view();
    view.task!.goal = 'changed';
    view.usage!.tokens = 0;
    const archive = runtime.archive();
    expect(archive.character.usage).toBeUndefined();
    archive.execution.task.current!.status = 'paused';
    runtime.stageControl(
      { type: 'cancel' },
      { kind: 'operator' },
      testAgentConfig(),
    );
    runtime.resumeExecution(archive, testAgentConfig());
    expect(runtime.view().task).toMatchObject({
      goal: 'build',
      status: 'running',
    });
    expect(runtime.view().usage?.tokens).toBe(1000);
  });

  it('keeps new conversations and pending events when resuming an execution-only checkpoint', () => {
    const runtime = createAgentRuntime();
    runtime.startScheduled(plan);
    runtime.stageControl(
      { type: 'pause' },
      { kind: 'operator' },
      testAgentConfig(),
    );
    const archived = runtime.executionSnapshot();
    expect(archived.character).toEqual({ conversation: {} });
    const current = runtime.snapshot();
    current.character.conversation = {
      exchanges: { public: ['newer conversation'] },
      lastChatAt: 200,
    };
    current.character.usage = { calls: 20, tokens: 2000, estimated: false };
    current.character.inbox = {
      version: 1,
      events: [
        {
          id: 'new-plan',
          kind: 'plan',
          state: 'pending',
          at: 200,
          audience: 'public',
        },
      ],
    };
    runtime.restore(current);
    runtime.resumeExecution(archived, testAgentConfig());
    expect(runtime.snapshot().character).toEqual(current.character);
    expect(runtime.view().task).toMatchObject({
      goal: plan.goal,
      status: 'running',
    });
    expect(runtime.executionSnapshot().character).toEqual({ conversation: {} });
    archived.execution.health.lastResponse = 'mutated caller checkpoint';
    expect(runtime.view().lastResponse).not.toBe('mutated caller checkpoint');
  });

  it('recovers an interrupted private execution without replaying its effects or stale messages', () => {
    const state = emptyState();
    state.execution.task.current = newTask('private', 'alice', 'alice');
    state.character.conversation.exchanges = {
      public: ['public'],
      alice: ['secret'],
    };
    state.character.inbox = {
      version: 1,
      events: [
        {
          id: 'chat',
          kind: 'chat',
          state: 'pending',
          at: 1,
          audience: 'alice',
        },
      ],
    };
    state.execution.effects.activeAction = {
      id: 'action',
      name: 'goto',
      taskId: 'old',
      revision: 0,
      status: 'running',
    };
    state.execution.checkpoint.pi = {
      taskId: 'fixture',
      revision: 0,
      version: 3,
      taskStartedAt: 1,
      audience: 'alice',
      messages: [],
      inFlight: { id: 'chat-tool', name: 'chat', state: 'executing' },
    };
    const runtime = createAgentRuntime();
    runtime.restore(JSON.parse(JSON.stringify(state)));
    runtime.recoverAfterRestart();
    expect(runtime.view().task?.status).toBe('needs_input');
    expect(runtime.view().requiresReassignment).toBe(true);
    expect(runtime.snapshot().execution.effects.activeAction?.status).toBe(
      'unknown',
    );
    expect(runtime.snapshot().execution.checkpoint.unknownEffect?.state).toBe(
      'unknown',
    );
    expect(runtime.snapshot().character.conversation.exchanges).toEqual({
      public: ['public'],
    });
    expect(runtime.snapshot().character.inbox?.events[0].state).toBe('unknown');
    expect(runtime.pendingMessages).toBe(false);
  });
});
