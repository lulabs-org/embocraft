import { expect, it } from 'vitest';
import { isActiveTask, isEndedTask, newTask } from './state';

it('separates active tasks from ended or missing ones', () => {
  const task = newTask('goal');
  expect(isActiveTask(task)).toBe(true);
  expect(isEndedTask(task)).toBe(false);
  task.status = 'waiting';
  expect(isActiveTask(task)).toBe(true);
  task.status = 'completed';
  expect(isActiveTask(task)).toBe(false);
  expect(isEndedTask(task)).toBe(true);
  task.status = 'paused';
  expect(isActiveTask(task)).toBe(false);
  expect(isEndedTask(task)).toBe(false);
  expect(isEndedTask(undefined)).toBe(true);
});
