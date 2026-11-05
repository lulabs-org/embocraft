import { expect, it, vi } from 'vitest';

import { captureTask } from './execution.service';

import { taskExecutionFixture as fixture } from '../../../../test/helpers/task-execution-fixture';

it('preserves action start time across capture updates and leaves legacy timestamps unknown', () => {
  const { state } = fixture();
  const memory = state.runtime.snapshot();
  memory.execution.effects.previous = {
    batchId: 'timed-batch',
    results: [
      { action: { type: 'chat' }, status: 'executing', startedAt: 1234 },
    ],
  };
  state.runtime.restore(memory);
  captureTask(state);
  const run = state.ledger.runs.at(-1)!;
  expect(run.actions?.[0].startedAt).toBe(1234);
  memory.execution.effects.previous = {
    batchId: 'timed-batch',
    results: [
      { action: { type: 'chat' }, status: 'succeeded', startedAt: 1234 },
    ],
  };
  state.runtime.restore(memory);
  captureTask(state);
  expect(run.actions).toHaveLength(1);
  expect(run.actions?.[0].startedAt).toBe(1234);
});

it('does not resume a task that changes while its configuration is being read', async () => {
  const { state, tasks, host, lease, message } = fixture();
  await tasks.controlMessage(
    'actor',
    'pause',
    lease,
    'pause-before-resume',
    message,
  );
  const run = state.ledger.runs[0];
  let release!: () => void;
  host.validateExecution = async (_id, overrides) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ...state.view, ...overrides };
  };
  const pending = tasks.controlTaskRun('actor', run.id, 'resume');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await tasks.controlTaskRun('actor', run.id, 'cancel');
  release();
  await expect(pending).rejects.toMatchObject({ status: 409 });
  expect(run.status).toBe('cancelled');
  expect(host.launch).not.toHaveBeenCalled();
});
