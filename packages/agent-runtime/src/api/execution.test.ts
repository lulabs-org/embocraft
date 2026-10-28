import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from './runtime';
import { emptyState } from '../contracts/state';
import { newTask } from '../agent/task/state';
import { testAgentConfig } from '../../../../tests/support/agent-config';

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
    expect(runtime.snapshot().inbox?.events).toHaveLength(1);
    runtime.startScheduled({ ...plan, eventId });
    expect(runtime.snapshot().inbox?.events).toHaveLength(1);
    expect(runtime.snapshot().inbox?.events[0]).toMatchObject({
      taskId: runtime.view().identity?.id,
      revision: 0,
      runId: plan.runId,
      planId: plan.planId,
    });
  });

  it('exposes detached views and archives while retaining character usage across execution switches', () => {
    const state = emptyState();
    state.task.usage = { calls: 10, tokens: 1000, estimated: false };
    const runtime = createAgentRuntime({ state });
    runtime.startScheduled(plan);
    const view = runtime.view();
    view.task!.goal = 'changed';
    view.usage!.tokens = 0;
    const archive = runtime.archive();
    expect(archive.task.usage).toBeUndefined();
    archive.task.current!.status = 'paused';
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

  it('recovers an interrupted private execution without replaying its effects or stale messages', () => {
    const state = emptyState();
    state.task.current = newTask('private', 'alice', 'alice');
    state.conversation.exchanges = { public: ['public'], alice: ['secret'] };
    state.inbox = {
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
    state.effects.activeAction = {
      id: 'action',
      name: 'goto',
      taskId: 'old',
      revision: 0,
      status: 'running',
    };
    state.checkpoint.pi = {
      version: 1,
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
    expect(runtime.snapshot().effects.activeAction?.status).toBe('unknown');
    expect(runtime.snapshot().checkpoint.unknownEffect?.state).toBe('unknown');
    expect(runtime.snapshot().conversation.exchanges).toEqual({
      public: ['public'],
    });
    expect(runtime.snapshot().inbox?.events[0].state).toBe('unknown');
    expect(runtime.pendingMessages).toBe(false);
  });
});
