import { expect, it } from 'vitest';

import { captureTask } from './execution';

import { taskExecutionFixture as fixture } from '../../../../test/helpers/task-execution-fixture';

it('preserves action start time across capture updates and leaves legacy timestamps unknown', () => {
  const { state } = fixture();
  state.memory.effects.previous = {
    batchId: 'timed-batch',
    results: [
      { action: { type: 'chat' }, status: 'executing', startedAt: 1234 },
    ],
  };
  captureTask(state);
  const run = state.ledger.runs.at(-1)!;
  expect(run.actions?.[0].startedAt).toBe(1234);
  state.memory.effects.previous = {
    batchId: 'timed-batch',
    results: [
      { action: { type: 'chat' }, status: 'succeeded', startedAt: 1234 },
    ],
  };
  captureTask(state);
  expect(run.actions).toHaveLength(1);
  expect(run.actions?.[0].startedAt).toBe(1234);
});
