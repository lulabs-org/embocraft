import { createAgentRuntime } from '@voxel/agent-runtime';

import { DEFAULT_TASK_LIMITS } from '@voxel/shared';
import { expect, it, vi } from 'vitest';
import {
  AICharacterRegistry,
  AICharacterWakeScheduler,
  executionState,
  type Job,
} from '../modules/ai-characters';
import { CharacterSnapshots } from '../modules/ai-characters/persistence/snapshots';
import { ManagementEvents } from '../modules/management';
import { PlanService, TaskSnapshots, newPlan, newRun } from '../modules/tasks';
import type { ManagementArchive } from './archive';
import { ManagementPersistence } from './management-persistence';

function fixture(save: (snapshot: ManagementArchive) => Promise<void>) {
  const plans = new PlanService();
  const committed = new PlanService();
  const events = new ManagementEvents();
  const jobs = new AICharacterRegistry();
  for (const id of ['a', 'b']) {
    const runtime = createAgentRuntime();
    jobs.set(id, {
      view: { id, name: id, status: 'idle', sessionId: `session-${id}` },
      runtime,
      ledger: plans,
      abort: new AbortController(),
    } as Job);
  }
  const scheduler = new AICharacterWakeScheduler();
  const cancel = vi.spyOn(scheduler, 'cancel');
  const presence = new Map<string, 'idle'>();
  const characters = new CharacterSnapshots();
  const tasks = new TaskSnapshots();
  const persistence = new ManagementPersistence(
    { load: async () => undefined, save },
    (snapshot, views) => events.commit(views, snapshot),
    {
      characters,
      tasks,
      captureExecutions: () =>
        tasks.captureExecutions([...jobs.values()].map(executionState)),
      captureCharacters: () =>
        characters.capture(
          jobs,
          () =>
            [...jobs.values()]
              .map((job) => structuredClone(job.view))
              .reverse(),
          presence,
        ),
      captureTasks: () => tasks.capture(plans),
      rejectTasks: (snapshot) => tasks.reject(snapshot, committed),
      rejectCharacters: (records, affected) =>
        characters.reject(records, jobs, affected, (id) =>
          scheduler.cancel(id),
        ),
      commitCharacters: (records, views) => characters.commit(records, views),
      restoreTasks: (snapshot) => tasks.restore(committed, snapshot),
    },
  );
  const persist = () => persistence.persist();
  return {
    plans,
    committed,
    events,
    persistence,
    jobs,
    cancel,
    presence,
    persist,
  };
}

function addTask(plans: PlanService) {
  const plan = {
    ...newPlan(
      {
        name: '巡查',
        goal: '观察',
        timing: { kind: 'immediate' },
        timeZone: 'UTC',
        limits: DEFAULT_TASK_LIMITS,
        totalTokenBudget: 500000,
      },
      100,
    ),
    characterId: 'a',
    characterName: 'a',
  };
  const run = newRun(plan, 100, 'manual');
  plans.plans.push(plan);
  plans.runs.push(run);
  plans.requests['a:request'] = plan.id;
  return { plan, run };
}

it('serializes joint snapshots and exposes both domains before publishing committed events', async () => {
  const pending: { snapshot: ManagementArchive; resolve: () => void }[] = [];
  const f = fixture(
    (snapshot) =>
      new Promise<void>((resolve) => pending.push({ snapshot, resolve })),
  );
  const seen: { resource: string; name?: string; goal?: string }[] = [];
  f.events.on((change) =>
    seen.push({
      resource: change.resource,
      name: f.persistence.characters.publicList().find((c) => c.id === 'a')
        ?.name,
      goal: f.committed.plans[0]?.goal,
    }),
  );
  const { plan } = addTask(f.plans);
  f.presence.set('a', 'idle');
  f.jobs.get('a')!.view.status = 'stopping';
  const first = f.persist();
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  f.jobs.get('a')!.view.name = 'changed';
  plan.goal = 'new goal';
  const second = f.persist();
  await Promise.resolve();
  expect(pending).toHaveLength(1);
  expect(f.persistence.characters.publicList()).toEqual([]);
  expect(f.committed.plans).toEqual([]);
  expect(seen).toEqual([]);
  expect(pending[0].snapshot.characters[0]).toMatchObject({
    id: 'a',
    name: 'a',
    status: 'idle',
  });
  expect(pending[0].snapshot.characters[0]).not.toHaveProperty('sessionId');
  expect(pending[0].snapshot.requests).toEqual({ 'a:request': plan.id });
  pending[0].resolve();
  await first;
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  expect(seen).toEqual(
    ['characters', 'plans', 'runs'].map((resource) => ({
      resource,
      name: 'a',
      goal: '观察',
    })),
  );
  expect(pending[1].snapshot.plans[0].goal).toBe('new goal');
  pending[1].resolve();
  await second;
  expect(
    f.persistence.characters.publicList().find((c) => c.id === 'a')?.name,
  ).toBe('changed');
  expect(f.committed.plans[0].goal).toBe('new goal');
});

it('flush waits for queued saves without capturing another snapshot or advancing the failure revision', async () => {
  let release!: () => void;
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const f = fixture(save);
  const revision = f.persistence.storageRevision;
  await f.persistence.flush();
  expect(save).not.toHaveBeenCalled();

  const saving = f.persist();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  f.jobs.get('a')!.view.name = 'not queued';
  let flushed = false;
  const flushing = f.persistence.flush(revision).then(() => {
    flushed = true;
  });
  await Promise.resolve();
  expect(flushed).toBe(false);

  release();
  await Promise.all([saving, flushing]);
  expect(flushed).toBe(true);
  expect(save).toHaveBeenCalledTimes(1);
  expect(
    f.persistence.characters.publicList().find((c) => c.id === 'a')?.name,
  ).toBe('a');
  expect(f.persistence.storageRevision).toBe(revision);
});

it('stops the affected character after a task-only failure and retains the last committed envelope and events', async () => {
  const save = vi.fn(async (_snapshot: ManagementArchive) => {});
  const f = fixture(save);
  const { plan } = addTask(f.plans);
  await f.persist();
  const before = structuredClone(f.committed.plans);
  const changed = vi.fn();
  f.events.on(changed);
  const revision = f.persistence.storageRevision;
  save.mockRejectedValueOnce(new Error('disk unavailable'));
  plan.goal = 'unsaved';
  await expect(f.persist()).rejects.toThrow('disk unavailable');
  expect(f.committed.plans).toEqual(before);
  expect(changed).not.toHaveBeenCalled();
  expect(f.persistence.tasks.storageFailed).toBe(true);
  expect(f.jobs.get('a')!.abort.signal.aborted).toBe(true);
  expect(f.jobs.get('a')!.storageFailed).toBe(true);
  expect(f.jobs.get('b')!.abort.signal.aborted).toBe(false);
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith('a');
  expect(() =>
    f.persistence.assertWritable(false, f.jobs.get('a')!.storageFailed),
  ).toThrow('存档失败');
  // A subsequent save may drain the queue, but cannot hide the earlier failed operation.
  await f.persist();
  await expect(f.persistence.flush(revision)).rejects.toThrow('操作结果待确认');
  expect(f.persistence.tasks.storageFailed).toBe(true);
});

it('limits character-only failures to changed jobs without marking the task ledger failed', async () => {
  const save = vi.fn(async (_snapshot: ManagementArchive) => {});
  const f = fixture(save);
  await f.persist();
  f.jobs.get('b')!.view.name = 'unsaved';
  save.mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(f.persist()).rejects.toThrow('disk unavailable');
  expect(
    f.persistence.characters.publicList().find((c) => c.id === 'b')?.name,
  ).toBe('b');
  expect(f.persistence.tasks.storageFailed).toBe(false);
  expect(f.jobs.get('a')!.abort.signal.aborted).toBe(false);
  expect(f.jobs.get('b')!.abort.signal.aborted).toBe(true);
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith('b');
});

it('keeps derived views out of storage while publishing their changes only after commit', async () => {
  const save = vi.fn(async (_snapshot: ManagementArchive) => {});
  const f = fixture(save);
  const view = f.jobs.get('a')!.view;
  Object.assign(view, {
    providerName: 'Provider display name',
    voiceServiceName: 'Voice display name',
    queuedTasks: [
      { id: 'queued', goal: 'Later', scheduledAt: 100, coalescedTriggers: 0 },
    ],
    taskExecution: { runId: 'run', limits: DEFAULT_TASK_LIMITS },
    usage: { calls: 1, tokens: 10, estimated: false },
    lastResponse: 'Derived response',
    taskRequiresReassignment: true,
    futureDisplayField: 'must not leak',
  });
  await f.persist();
  const saved = save.mock.calls[0][0].characters[0];
  for (const field of [
    'providerName',
    'voiceServiceName',
    'sessionId',
    'task',
    'taskExecution',
    'queuedTasks',
    'usage',
    'lastResponse',
    'taskRequiresReassignment',
    'futureDisplayField',
  ])
    expect(saved).not.toHaveProperty(field);
  expect(
    f.persistence.characters.publicList().find((item) => item.id === 'a'),
  ).toMatchObject({
    providerName: 'Provider display name',
    queuedTasks: [{ id: 'queued' }],
  });

  const seen = vi.fn();
  f.events.on(seen);
  view.voiceServiceName = 'New voice name';
  save.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(f.persist()).rejects.toThrow('storage unavailable');
  expect(seen).not.toHaveBeenCalled();
  expect(
    f.persistence.characters.publicList().find((item) => item.id === 'a')
      ?.voiceServiceName,
  ).toBe('Voice display name');
  await f.persist();
  expect(save.mock.calls[2][0].characters[0]).toEqual(saved);
  expect(seen).toHaveBeenCalledWith(
    expect.objectContaining({ resource: 'characters', characterIds: ['a'] }),
  );
});
