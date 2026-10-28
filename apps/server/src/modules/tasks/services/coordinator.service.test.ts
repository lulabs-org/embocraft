import { emptyState, newTask } from '@voxel/agent-runtime/testing';

import { expect, it, vi } from 'vitest';

import { captureTask } from './execution.service';

import { taskExecutionFixture as fixture } from '../../../../test/helpers/task-execution-fixture';

it('executes task policy through the narrow host port without an Agent registry or world session', async () => {
  const { state, tasks, host } = fixture();
  state.runtime.restore(emptyState());
  const plan = await tasks.createTaskPlan('actor', {
    name: 'Explicit work',
    goal: 'Observe',
    timing: { kind: 'immediate' },
    timeZone: 'UTC',
  });
  expect(tasks.plans.plans).toHaveLength(1);
  expect(tasks.plans.runs).toHaveLength(1);
  expect(state.runtime.snapshot().execution.task.current?.goal).toBe('Observe');
  expect(host.launch).toHaveBeenCalledWith('actor');
  expect(tasks.plans.runs[0].planId).toBe(plan.id);
});

it('deduplicates the same world command while pending and after its task revision changes', async () => {
  const { state, tasks, save, stopped, lease, message } = fixture();
  const first = tasks.controlMessage(
    'actor',
    'pause',
    lease,
    'world-1',
    message,
  );
  const second = tasks.controlMessage(
    'actor',
    'pause',
    lease,
    'world-1',
    message,
  );
  expect(second).toBe(first);
  const result = await first;
  expect(state.runtime.snapshot().execution.task.current?.status).toBe(
    'paused',
  );
  expect(state.runtime.snapshot().execution.task.identity?.revision).toBe(
    lease.revision + 1,
  );
  expect(
    await tasks.controlMessage('actor', 'pause', lease, 'world-1', message),
  ).toEqual(result);
  expect(stopped).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
  expect(tasks.plans.runs).toHaveLength(1);
  expect(tasks.plans.runs[0].source).toBe('chat');
  expect(tasks.plans.runs[0].planId).toBeUndefined();
});

it('rejects stale task leases before interrupting a runner or recording a chat run', async () => {
  const { state, tasks, stopped, save, lease, message } = fixture();
  const before = structuredClone(state.runtime.snapshot());
  await expect(
    tasks.controlMessage(
      'actor',
      'cancel',
      { ...lease, revision: lease.revision + 1 },
      'stale',
      message,
    ),
  ).rejects.toThrow('任务已修改');
  expect(stopped).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(state.runtime.snapshot()).toEqual(before);
  expect(tasks.plans.runs).toHaveLength(0);
});

it('retains the original failed world command without repeating its transition or save', async () => {
  const { tasks, save, stopped, lease, message } = fixture();
  const failure = new Error('fixture storage failure');
  save.mockRejectedValueOnce(failure);
  const first = tasks.controlMessage(
    'actor',
    'pause',
    lease,
    'failed-write',
    message,
  );
  await expect(first).rejects.toBe(failure);
  const retry = tasks.controlMessage(
    'actor',
    'pause',
    lease,
    'failed-write',
    message,
  );
  expect(retry).toBe(first);
  await expect(retry).rejects.toBe(failure);
  expect(save).toHaveBeenCalledTimes(1);
  expect(stopped).toHaveBeenCalledTimes(1);
});

it.each([
  { actor: 'bob' },
  {
    data: {
      text: '取消',
      name: 'Alice',
      kind: 'text',
      scope: 'public',
      recipients: ['actor'],
    },
  },
])(
  'retains private task ownership when a world command changes authority: %j',
  async (changes) => {
    const { state, tasks, stopped, lease, message } = fixture();
    await expect(
      tasks.controlMessage('actor', 'cancel', lease, 'unauthorized', {
        ...message,
        ...changes,
      }),
    ).rejects.toThrow('仅任务发起者');
    expect(state.runtime.snapshot().execution.task.current?.status).toBe(
      'waiting',
    );
    expect(stopped).not.toHaveBeenCalled();
    expect(tasks.plans.runs).toHaveLength(0);
  },
);

it('rechecks identity after waiting for a runner so an old command cannot mutate a newer execution', async () => {
  const { state, tasks, stopped, save, lease, message, setAfterInterrupt } =
    fixture();
  let release!: () => void;
  setAfterInterrupt(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pending = tasks.controlMessage(
    'actor',
    'cancel',
    lease,
    'racing',
    message,
  );
  await vi.waitFor(() => expect(stopped).toHaveBeenCalled());
  state.runtime.restore({
    version: 4 as const,
    character: { ...emptyState().character },
    execution: {
      ...emptyState().execution,
      task: { current: newTask('New execution', 'alice', 'alice') },
    },
  });
  captureTask(state);
  const newer = structuredClone(state.runtime.snapshot());
  release();
  await expect(pending).rejects.toThrow('任务已修改');
  expect(state.runtime.snapshot()).toEqual(newer);
  expect(state.runtime.snapshot().execution.task.current?.status).toBe(
    'running',
  );
  expect(save).not.toHaveBeenCalled();
});

it('preserves a completion that settles while a valid cancellation waits for the runner', async () => {
  const { state, tasks, lease, message, setAfterInterrupt } = fixture();
  setAfterInterrupt(async () => {
    const completed = state.runtime.snapshot();
    completed.execution.task.current!.status = 'completed';
    completed.execution.task.current!.summary = 'Verified completion';
    state.runtime.restore(completed);
  });
  await tasks.controlMessage('actor', 'cancel', lease, 'finished', message);
  expect(state.runtime.snapshot().execution.task.current?.status).toBe(
    'completed',
  );
  expect(tasks.plans.runs[0].status).toBe('completed');
});

it('rejects a reused world command ID with different content instead of applying another transition', async () => {
  const { state, tasks, lease, message, stopped } = fixture();
  await tasks.controlMessage('actor', 'pause', lease, 'same', message);
  expect(() =>
    tasks.controlMessage('actor', 'cancel', lease, 'same', message),
  ).toThrow('同一命令标识');
  expect(state.runtime.snapshot().execution.task.current?.status).toBe(
    'paused',
  );
  expect(stopped).toHaveBeenCalledTimes(1);
});
