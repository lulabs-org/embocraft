import { expect, it, vi } from 'vitest';
import { ManagementCommands } from './commands';
import { taskCommandBody } from '../tasks/command-policy';
import { AppError } from '../../common/errors';

type Request = Parameters<ManagementCommands['execute']>[0];

function request(body: unknown, id = 'request'): Request {
  return {
    method: 'POST',
    path: '/tasks/plans',
    body,
    header: () => id,
  } as unknown as Request;
}

it('preserves task precondition normalization and receipt identity', async () => {
  const commands = new ManagementCommands(taskCommandBody);
  const action = vi.fn(async (id) => ({ id }));
  await commands.execute(
    request({ goal: 'observe', expectedPlanRevision: 1 }),
    'tasks',
    action,
  );
  const validate = vi.fn(() => {
    throw new Error('must not revalidate a committed retry');
  });
  await expect(
    commands.execute(
      request({
        goal: 'observe',
        expectedPlanRevision: 2,
        expectedTask: { id: 'new' },
      }),
      'tasks',
      action,
      validate,
    ),
  ).resolves.toEqual({ id: 'request' });
  expect(action).toHaveBeenCalledTimes(1);
  expect(validate).not.toHaveBeenCalled();
  expect(() =>
    commands.execute(request({ goal: 'changed' }), 'tasks', action),
  ).toThrow('不同');
});

it('checks admission again at execution, records the rejection, and continues the lane', async () => {
  const commands = new ManagementCommands(taskCommandBody);
  let release!: () => void;
  let writable = true;
  const first = commands.execute(request({}, 'first'), 'tasks', async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    writable = false;
  });
  const action = vi.fn(async () => 'should not execute');
  const validate = vi.fn(() => {
    if (!writable) throw new AppError('计划已改变', 409);
  });
  const second = commands.execute(
    request({}, 'second'),
    'tasks',
    action,
    validate,
  );
  const rejected = expect(second).rejects.toThrow('计划已改变');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(validate).toHaveBeenCalledTimes(1);
  release();
  await first;
  await rejected;
  expect(validate).toHaveBeenCalledTimes(2);
  expect(action).not.toHaveBeenCalled();
  expect(commands.get('second')).toMatchObject({
    state: 'rejected',
    error: { code: 'CONFLICT', status: 409 },
  });
  await expect(
    commands.execute(request({}, 'third'), 'tasks', async () => 'saved'),
  ).resolves.toBe('saved');
});
