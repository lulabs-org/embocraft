// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_TASK_LIMITS, type TaskRun } from '@voxel/shared';
import type { PublicPlanView } from '@voxel/shared/management';
import { tasksApi } from './api';
import { useTaskPlans, type TaskPlansController } from './useTaskPlans';
import { TaskPlans } from './TaskPlans';

const gateway = vi.hoisted(() => ({
  refresh: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('../../../network/gateway', () => ({
  refreshOnGatewayChange: (read: () => Promise<void>) => {
    gateway.refresh = read;
    void read();
    return () => {
      if (gateway.refresh === read) gateway.refresh = undefined;
    };
  },
}));
vi.mock('./api', () => ({
  tasksApi: {
    list: vi.fn(),
    get: vi.fn(),
    runs: vi.fn(),
    save: vi.fn(),
    control: vi.fn(),
  },
}));
vi.mock('../execution/api', () => ({
  controlTaskRun: vi.fn(),
  displayedTaskIdentity: () => null,
}));
const plan = (id: string): PublicPlanView => ({
  id,
  name: id,
  goal: 'original goal',
  timing: { kind: 'interval', everyMs: 3600000 },
  timeZone: 'Asia/Shanghai',
  limits: { ...DEFAULT_TASK_LIMITS },
  totalTokenBudget: 500000,
  totalTokenBudgetEnabled: true,
  state: 'paused',
  reason: '',
  spentTokens: 0,
  createdAt: 1,
  updatedAt: 1,
  resourceVersion: 1,
  taskIdentity: null,
});
const run = (id: string): TaskRun => ({
  id,
  planId: 'a',
  source: 'manual',
  scheduledAt: 1,
  snapshot: plan('a'),
  status: 'completed',
  reason: '',
  totalTokens: 0,
  logs: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let host: HTMLDivElement, root: Root, current: TaskPlansController;
function Harness({ disabled = false }: { disabled?: boolean }) {
  current = useTaskPlans({ characters: [], active: true, disabled });
  return null;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(tasksApi.list).mockResolvedValue({
    items: [plan('a'), plan('b')],
    total: 2,
  });
  vi.mocked(tasksApi.get).mockImplementation(async (id) => plan(id));
  vi.mocked(tasksApi.runs).mockResolvedValue({
    active: [],
    items: [],
    total: 0,
  });
  vi.mocked(tasksApi.save).mockResolvedValue(plan('a'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('auto selects the first plan and discards reads from a previous selection', async () => {
  await act(async () => root.render(<Harness />));
  expect(current.plan?.id).toBe('a');
  const stale = deferred<PublicPlanView>();
  vi.mocked(tasksApi.get).mockImplementation((id) =>
    id === 'a' ? stale.promise : Promise.resolve(plan(id)),
  );
  let reading!: Promise<void>;
  await act(async () => {
    reading = gateway.refresh!();
  });
  const signal = vi.mocked(tasksApi.get).mock.calls.at(-1)![1]!;
  await act(async () => current.openPlan('b'));
  expect(signal.aborted).toBe(true);
  await act(async () => {
    stale.resolve(plan('a'));
    await reading;
  });
  expect(current.plan?.id).toBe('b');
});

it('preserves loaded history depth across refresh and resets it on plan selection', async () => {
  vi.mocked(tasksApi.runs).mockImplementation(async (_id, offset) => ({
    active: [run('shared')],
    items: [run(String(offset))],
    total: 60,
    nextOffset: (offset ?? 0) + 20,
  }));
  await act(async () => root.render(<Harness />));
  await act(async () => current.loadOlderRecords());
  expect(current.runs.map((r) => r.id)).toEqual(['shared', '0', '20']);
  await act(async () => gateway.refresh!());
  expect(current.runs.map((r) => r.id)).toEqual(['shared', '0', '20']);
  await act(async () => current.openPlan('b'));
  expect(current.runs.map((r) => r.id)).toEqual(['shared', '0']);
});

it('serializes mutations and preserves save arguments, selection and tab', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => current.setDetailTab('history'));
  const pending = deferred<PublicPlanView>();
  vi.mocked(tasksApi.save).mockReturnValue(pending.promise);
  const draft = { ...plan('a'), goal: 'edited' };
  let saving!: Promise<void>;
  await act(async () => {
    saving = current.savePlan(draft, 'request', 'character');
  });
  await act(async () => current.control('pause'));
  expect(tasksApi.control).not.toHaveBeenCalled();
  expect(tasksApi.save).toHaveBeenCalledWith(
    'character',
    draft,
    plan('a'),
    'request',
  );
  await act(async () => {
    pending.resolve(plan('a'));
    await saving;
  });
  expect(current.selected).toBe('a');
  expect(current.detailTab).toBe('history');
  expect(current.locked).toBe(false);
});

it('retains creation state on failure and opens the saved plan on success', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => current.startCreating());
  vi.mocked(tasksApi.save).mockRejectedValueOnce(new Error('save failed'));
  await act(async () =>
    current.createPlan(plan('new'), 'request', 'character'),
  );
  expect(current.creating).toBe(true);
  expect(current.error).toBe('save failed');
  vi.mocked(tasksApi.save).mockResolvedValueOnce(plan('new'));
  await act(async () =>
    current.createPlan(plan('new'), 'request', 'character'),
  );
  expect(current.creating).toBe(false);
  expect(current.plan?.id).toBe('new');
});

it('keeps the editor DOM, unsaved values and scroll position through tabs and save refresh', async () => {
  await act(async () =>
    root.render(<TaskPlans characters={[]} active disabled={false} />),
  );
  const form = host.querySelector('form')!;
  const goal = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(goal, 'unsaved goal');
    goal.dispatchEvent(new Event('input', { bubbles: true }));
  });
  host.scrollTop = 400;
  const tabs = host.querySelectorAll<HTMLButtonElement>(
    '.plans-detail-tabs button',
  );
  await act(async () => tabs[2].click());
  await act(async () => tabs[0].click());
  expect(host.querySelector('form')).toBe(form);
  expect(goal.value).toBe('unsaved goal');
  await act(async () =>
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ),
  );
  expect(tasksApi.save).toHaveBeenCalledWith(
    '',
    expect.objectContaining({ goal: 'unsaved goal' }),
    expect.objectContaining({ id: 'a' }),
    expect.any(String),
  );
  expect(host.querySelector('form')).toBe(form);
  expect(host.scrollTop).toBe(400);
  expect(goal.value).toBe('unsaved goal');
});
