import { emptyState } from '../../contracts/state';

import { expect, it, vi } from 'vitest';
import type { Observation } from '../../contracts';
import { initialToolState } from '../../contracts/tool-state';
import type { TaskService } from '../task/service';
import { TurnHealthMonitor } from './health';

function fixture(maxStalledTurns?: number) {
  const monitor = new TurnHealthMonitor();
  const finish = vi.fn();
  const options = {
    maxStalledTurns,
    state: initialToolState(),
    attached: true,
    current: () => true,
    memory: {
      version: 4 as const,
      character: { ...emptyState().character },
      execution: {
        ...emptyState().execution,
        task: { current: { status: 'running' } as never },
      },
    },
    service: { finish, lease: () => ({}) } as unknown as TaskService,
    hasMessage: false,
    launched: false,
    observation: {
      self: { id: 'agent' },
      blocks: [],
      players: [],
      events: [],
    } as unknown as Observation,
  };
  return { options, finish, turn: () => monitor.recordTurn(options) };
}

it('uses the configured consecutive tool failure threshold', () => {
  const f = fixture(5);
  f.options.state.hadError = true;
  f.options.hasMessage = true;
  for (let i = 0; i < 4; i++) f.turn();
  expect(f.finish).not.toHaveBeenCalled();
  f.turn();
  expect(f.finish).toHaveBeenCalledWith(
    {},
    { status: 'blocked', reason: '连续 5 轮工具失败，已停止本次事件。' },
  );
});

it('uses the configured lack-of-progress threshold', () => {
  const f = fixture(2);
  f.turn();
  f.turn();
  expect(f.finish).not.toHaveBeenCalled();
  f.turn();
  expect(f.finish).toHaveBeenCalledWith(
    {},
    {
      status: 'blocked',
      reason: '连续 2 轮失败或没有实际进展，已停止自动重试。',
    },
  );
});

it('keeps the old default and allows disabled runtime limits', () => {
  const f = fixture();
  f.options.state.hadError = true;
  f.options.hasMessage = true;
  f.turn();
  f.turn();
  expect(f.finish).not.toHaveBeenCalled();
  f.turn();
  expect(f.finish).toHaveBeenCalledOnce();
  const unlimited = fixture(Infinity);
  unlimited.options.state.hadError = true;
  for (let i = 0; i < 10; i++) unlimited.turn();
  expect(unlimited.finish).not.toHaveBeenCalled();
});
