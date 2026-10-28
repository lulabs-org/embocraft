import { expect, it } from 'vitest';

import { migrateArchive } from './migrate-archive';

import { newPlan, newRun } from '../modules/tasks';

import { DEFAULT_TASK_LIMITS } from '@voxel/shared';

const draft = {
  name: '巡查',
  goal: '观察',
  timing: { kind: 'immediate' as const },
  timeZone: 'UTC',
  limits: DEFAULT_TASK_LIMITS,
  totalTokenBudget: 500000,
};

it('migrates pure chat independently, preserves mixed/manual plans, IDs, request scopes and budgets', () => {
  const chat = newPlan(draft, 100),
    mixed = newPlan(draft, 100),
    legacy = newPlan(draft, 100);
  chat.spentTokens = 12;
  mixed.spentTokens = 30;
  const c = newRun(chat, 100, 'chat'),
    m = newRun(mixed, 101, 'manual'),
    mc = newRun(mixed, 102, 'chat');
  Object.assign(mixed, { agentId: 'a', agentName: 'A' });
  Object.assign(m, { agentId: 'a', agentName: 'A' });
  const records = [
    {
      id: 'a',
      name: 'A',
      taskBook: {
        version: 1,
        plans: [chat, mixed, legacy],
        runs: [c, m, mc],
        currentRunId: c.id,
        requests: { same: mixed.id },
      },
    },
    {
      id: 'b',
      name: 'B',
      taskBook: {
        version: 1,
        plans: [],
        runs: [],
        requests: { same: legacy.id },
      },
    },
  ];
  const result = migrateArchive(
    records as unknown as Parameters<typeof migrateArchive>[0],
  );
  expect(result.plans.map((p) => p.id)).toEqual([mixed.id, legacy.id]);
  expect(result.plans[0]).toMatchObject({
    characterId: 'a',
    revision: 1,
    spentTokens: 30,
  });
  expect(result.plans[1].imported).toBe(true);
  expect(result.plans[0]).not.toHaveProperty('agentId');
  expect(result.runs.find((r) => r.id === m.id)).not.toHaveProperty(
    'agentName',
  );
  expect(result.runs.find((r) => r.id === c.id)).toMatchObject({
    characterId: 'a',
    source: 'chat',
  });
  expect(result.runs.find((r) => r.id === c.id)?.planId).toBeUndefined();
  expect(result.runs.find((r) => r.id === mc.id)?.planId).toBe(mixed.id);
  expect(result.characters[0]).toMatchObject({ currentRunId: c.id });
  expect(result.characters[0].taskBook).toBeUndefined();
  expect(result.requests).toEqual({ 'a:same': mixed.id, 'b:same': legacy.id });
  expect(migrateArchive(result)).toEqual(result);
  expect(records[0].taskBook.plans).toHaveLength(3);
});

it('rejects duplicate identities, dangling current runs and unsupported envelopes before execution', () => {
  expect(() =>
    migrateArchive([{ id: 'same' }, { id: 'same' }] as unknown as Parameters<
      typeof migrateArchive
    >[0]),
  ).toThrow('标识');
  expect(() =>
    migrateArchive({
      version: 99,
      characters: [],
      plans: [],
      runs: [],
      requests: {},
    } as unknown as Parameters<typeof migrateArchive>[0]),
  ).toThrow('格式');
  expect(() =>
    migrateArchive({
      version: 2,
      characters: [{ id: 'a', currentRunId: 'missing' }],
      plans: [],
      runs: [],
      requests: {},
    } as unknown as Parameters<typeof migrateArchive>[0]),
  ).toThrow('当前执行');
});

it('migrates v1 ownership without losing execution checkpoints, history or request identities', () => {
  const plan = newPlan(draft, 100);
  plan.spentTokens = 1234;
  const run = newRun(plan, 100, 'manual');
  const runtime = {
    version: 2,
    identity: { id: 'task-identity', revision: 7, startedAt: 100 },
    marker: { agentId: 'opaque-runtime-data' },
  };
  const legacy = {
    version: 1,
    agents: [{ id: 'a', name: '角色', currentRunId: run.id, runtime }],
    plans: [
      {
        ...plan,
        agentId: 'a',
        agentName: '角色',
        latestRun: {
          ...run,
          agentId: 'a',
          agentName: '角色',
        },
      },
    ],
    runs: [
      { ...run, agentId: 'a', agentName: '角色', runtime },
      {
        ...run,
        id: 'deleted-character-history',
        agentId: 'deleted',
        agentName: '旧角色',
      },
    ],
    requests: { 'a:original-request': plan.id },
  };
  const original = JSON.stringify(legacy);
  const migrated = migrateArchive(JSON.parse(original));
  expect(migrated.version).toBe(3);
  expect(migrated).not.toHaveProperty('agents');
  expect(migrated.characters[0]).toMatchObject({
    id: 'a',
    currentRunId: run.id,
    runtime,
  });
  expect(migrated.plans[0]).toMatchObject({
    id: plan.id,
    characterId: 'a',
    characterName: '角色',
    spentTokens: 1234,
    latestRun: { characterId: 'a', characterName: '角色' },
  });
  expect(migrated.runs[0]).toMatchObject({
    id: run.id,
    characterId: 'a',
    characterName: '角色',
    runtime,
  });
  expect(migrated.runs[1]).toMatchObject({
    characterId: 'deleted',
    characterName: '旧角色',
  });
  for (const resource of [
    ...migrated.plans,
    ...migrated.runs,
    migrated.plans[0].latestRun!,
  ]) {
    expect(resource).not.toHaveProperty('agentId');
    expect(resource).not.toHaveProperty('agentName');
  }
  expect(migrated.requests).toEqual(legacy.requests);
  expect(migrateArchive(migrated)).toEqual(migrated);
  expect(JSON.stringify(legacy)).toBe(original);
});
