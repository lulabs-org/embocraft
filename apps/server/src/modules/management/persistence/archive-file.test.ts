import { expect, it, vi } from 'vitest';
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManagementArchive, writeManagementArchive } from './archive-file';
import type { ManagementArchive } from '../domain/archive';
import { migrateArchive } from './migrate-archive';
import { newPlan, newRun } from '../../tasks';
import { DEFAULT_TASK_LIMITS } from '@voxel/shared';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

it('keeps the previous complete archive on rename failure, cleans the temporary file, and allows a later save', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'joint-archive-'));
  const path = join(directory, 'providers.json.agents.json');
  const before: ManagementArchive = {
    version: 3,
    characters: [],
    plans: [],
    runs: [],
    requests: { previous: 'committed' },
  };
  const after: ManagementArchive = {
    ...before,
    requests: { next: 'committed' },
  };
  try {
    await writeManagementArchive(path, before);
    const original = await readFile(path, 'utf8');
    vi.mocked(rename).mockRejectedValueOnce(new Error('rename failed'));
    await expect(writeManagementArchive(path, after)).rejects.toThrow(
      'rename failed',
    );
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readManagementArchive(path)).toEqual(before);
    expect(await readdir(directory)).toEqual(['providers.json.agents.json']);
    await writeManagementArchive(path, after);
    expect(await readManagementArchive(path)).toEqual(after);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(['providers.json.agents.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const draft = {
  name: '巡查',
  goal: '观察',
  timing: { kind: 'immediate' as const },
  timeZone: 'UTC',
  limits: DEFAULT_TASK_LIMITS,
  totalTokenBudget: 500000,
};

it('backs up the old archive once and atomically writes the independent envelope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plans-upgrade-'));
  const path = join(dir, 'characters.json');
  try {
    const old = JSON.stringify([{ id: 'a', name: 'A' }]);
    await writeFile(path, old);
    const archive = await readManagementArchive(path);
    expect(
      await readFile(path + '.before-task-plan-module-v1.bak', 'utf8'),
    ).toBe(old);
    await writeManagementArchive(path, archive!);
    expect(await readManagementArchive(path)).toEqual(archive);
    expect(
      await readFile(path + '.before-task-plan-module-v1.bak', 'utf8'),
    ).toBe(old);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('migrates v1 ownership without losing execution checkpoints, history or request identities', async () => {
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
  const dir = await mkdtemp(join(tmpdir(), 'characters-upgrade-'));
  const path = join(dir, 'providers.json.agents.json');
  try {
    await writeFile(path, original);
    const migrated = (await readManagementArchive(path))!;
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
    expect(
      await readFile(path + '.before-character-events-v3.bak', 'utf8'),
    ).toBe(original);
    await writeManagementArchive(path, migrated);
    expect(await readManagementArchive(path)).toEqual(migrated);
    expect(migrateArchive(migrated)).toEqual(migrated);
    expect(
      await readFile(path + '.before-character-events-v3.bak', 'utf8'),
    ).toBe(original);
    expect(JSON.stringify(legacy)).toBe(original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
