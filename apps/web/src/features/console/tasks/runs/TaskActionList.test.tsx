// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { TaskRunAction } from '@voxel/shared';
import { TaskActionList } from './TaskActionList';

it('shows newest records first, preserves numbering and formats start times in the plan timezone', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const actions: TaskRunAction[] = [
    { call: 1, index: 0, kind: 'chat', status: 'succeeded', detail: '{}' },
    {
      call: 2,
      index: 0,
      kind: 'chat',
      status: 'succeeded',
      detail: '{}',
      startedAt: Date.UTC(2026, 9, 24, 1, 2, 3),
    },
    { call: 2, index: 1, kind: 'chat', status: 'pending', detail: '{}' },
  ];
  try {
    await act(async () =>
      root.render(
        <TaskActionList actions={actions} timeZone="Asia/Shanghai" />,
      ),
    );
    expect(
      [...host.querySelectorAll('.task-action-number')].map(
        (el) => el.textContent,
      ),
    ).toEqual(['3', '2', '1']);
    expect(host.querySelector('time')?.textContent).toContain('09:02:03');
    expect(host.querySelector('time')?.dateTime).toBe(
      '2026-10-24T01:02:03.000Z',
    );
    expect(host.querySelectorAll('.task-action-time')).toHaveLength(3);
    expect(actions.map((action) => action.call)).toEqual([1, 2, 2]);
    const toggle = host.querySelector<HTMLButtonElement>(
      '.task-action-raw-toggle',
    )!;
    const data = host.querySelector<HTMLPreElement>('.task-action-raw-data')!;
    expect(data.hidden).toBe(true);
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(data.hidden).toBe(false);
    expect(host.querySelector('.task-action-raw-toggle')).toBe(toggle);
    await act(async () => toggle.click());
    expect(data.hidden).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
