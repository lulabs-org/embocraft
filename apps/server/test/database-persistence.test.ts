import { createAgentRuntime } from '@voxel/agent-runtime';
import { testAgentConfig } from '../../../tests/support/agent-config';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  DEFAULT_BAILIAN_ASR,
  DEFAULT_WHISPER_ASR,
  DEFAULT_TASK_LIMITS,
} from '@voxel/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabaseClient } from '../src/core/database/client';
import {
  AICharacterManager,
  CharacterQueries,
} from '../src/modules/ai-characters';
import { AsrService } from '../src/modules/asr/services/asr.service';
import { DatabaseAsrServicePersistence } from '../src/modules/asr/persistence/database-asr-services';
import { AppError } from '../src/core/errors/app-error';
import { domainEvents } from '../src/core/events/domain-events';
import { DatabaseVoiceServicePersistence } from '../src/modules/tts/persistence/database-voice-services';
import { TtsService } from '../src/modules/tts';
import { bootstrapProviders } from './helpers/provider-seed';
import { DatabaseProviderRepository } from '../src/modules/providers';
import { DEFAULT_TTS_PROVIDER } from '../prisma/seed-data';
import {
  taskChanges,
  type ManagementArchive,
} from '../src/persistence/management-archive';
import { DatabaseManagementArchive } from '../src/persistence/database-management-archive';
import { createServer } from '../src/server';
import { newPlan, newRun } from '../src/modules/tasks';
import { settleTaskUsage } from '../src/modules/tasks/domain/model';
import { storedCharacter, storedPlan, storedRun } from './helpers/task-records';
import { taskExecutionFixture } from './helpers/task-execution-fixture';
import { TaskCoordinator } from '../src/modules/tasks';

const url = process.env.TEST_DATABASE_URL;
const db = url ? createDatabaseClient(url) : undefined;

describe.skipIf(!url)('PostgreSQL provider and management persistence', () => {
  beforeEach(async () => {
    await db!.tokenUsage.deleteMany();
    await db!.chatMessageRecipient.deleteMany();
    await db!.chatMessage.deleteMany();
    await db!.player.deleteMany();
    await db!.agentCharacterState.deleteMany();
    await db!.agentRequest.deleteMany();
    await db!.agentRun.deleteMany();
    await db!.agentPlan.deleteMany();
    await db!.agentCharacter.deleteMany();
    await db!.agentProvider.deleteMany();
    await db!.ttsProvider.deleteMany();
    await db!.asrProvider.deleteMany();
    await db!.blockEdit.deleteMany();
    await db!.world.deleteMany();
  });
  afterAll(async () => db?.$disconnect());

  it('manages offline characters from database rows without retaining runtime instances', async () => {
    const providers = new DatabaseProviderRepository(db!);
    await bootstrapProviders(providers);
    const archive = new DatabaseManagementArchive(db!);
    const manager = new AICharacterManager(providers, '', archive);
    try {
      await manager.load();
      const load = vi
        .spyOn(archive, 'load')
        .mockRejectedValue(new Error('Queries must not load the full archive'));
      const role = await manager.create({
        providerId: 'ollama',
        model: 'qwen2.5:3b',
        name: 'Offline',
        joinWorld: false,
      });
      expect(manager.jobs.size).toBe(0);
      expect((await manager.list()).map((item) => item.id)).toEqual([role.id]);
      expect(await manager.hasProviderReference('ollama')).toBe(true);
      expect(await manager.hasVoiceServiceReference('missing')).toBe(false);
      expect(load).not.toHaveBeenCalled();
      await db!.agentCharacter.update({
        where: { id: role.id },
        data: { name: 'Changed in SQL' },
      });
      await manager.update(role.id, {
        roleDescription: 'Keep the database name',
      });
      expect((await new CharacterQueries(db!).get(role.id)).name).toBe(
        'Changed in SQL',
      );
      const plan = await manager.tasks.createTaskPlan(role.id, {
        name: 'Later',
        goal: 'Inspect',
        timing: { kind: 'interval', everyMs: 60000 },
        timeZone: 'UTC',
        limits: DEFAULT_TASK_LIMITS,
        totalTokenBudget: 500000,
      });
      expect(manager.jobs.size).toBe(0);
      await manager.tasks.dispatchDue(Date.now() + 120000);
      expect(
        (await manager.tasks.taskRuns(role.id, plan.id)).items[0].status,
      ).toBe('skipped');
      expect(manager.jobs.size).toBe(0);
      await manager.remove(role.id);
      expect(await db!.agentCharacter.count()).toBe(0);
      expect(
        (await manager.tasks.publicPlan(plan.id)).characterId,
      ).toBeUndefined();
      expect(
        (await manager.tasks.publicRuns(undefined, plan.id)).items,
      ).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  it('production commits preserve untouched database tasks and avoid restoring unrelated history', async () => {
    const providers = new DatabaseProviderRepository(db!);
    await bootstrapProviders(providers);
    const archive = new DatabaseManagementArchive(db!);
    await archive.save({
      version: 3,
      characters: [
        storedCharacter({ providerId: 'ollama', model: 'qwen2.5:3b' }),
      ],
      plans: [
        storedPlan({ id: 'keep', characterId: 'actor' }),
        storedPlan({ id: 'removed', characterId: 'actor' }),
      ],
      runs: [
        storedRun({
          id: 'history',
          planId: 'keep',
          characterId: 'actor',
          status: 'completed',
          runtime: createAgentRuntime().executionSnapshot(),
        }),
      ],
      requests: { 'actor:keep': 'keep' },
    });
    const manager = new AICharacterManager(providers, '', archive);
    await manager.load();
    try {
      await db!.agentPlan.update({
        where: { id: 'keep' },
        data: { name: 'Database edit' },
      });
      await db!.agentPlan.delete({ where: { id: 'removed' } });
      const existing = await db!.agentPlan.findUniqueOrThrow({
        where: { id: 'keep' },
      });
      await db!.agentPlan.create({
        data: {
          ...existing,
          scheduleSpec: existing.scheduleSpec as Prisma.InputJsonValue,
          limits: existing.limits as Prisma.InputJsonValue,
          id: 'external',
          position: 100,
        },
      });
      await db!.agentRequest.create({
        data: { key: 'actor:external', planId: 'external' },
      });
      await db!.agentRunCheckpoint.update({
        where: { runId: 'history' },
        data: { version: 999 },
      });
      await manager.update('actor', {
        roleDescription: 'Only update character',
      });
      const created = await manager.tasks.createTaskPlan('actor', {
        name: 'New schedule',
        goal: 'Observe',
        timing: { kind: 'interval', everyMs: 60000 },
        timeZone: 'UTC',
      });
      expect(
        await db!.agentPlan.findUnique({ where: { id: created.id } }),
      ).toMatchObject({ position: 101 });
      expect(
        await db!.agentPlan.findUnique({ where: { id: 'keep' } }),
      ).toMatchObject({ name: 'Database edit', position: 0 });
      expect(
        await db!.agentPlan.findUnique({ where: { id: 'removed' } }),
      ).toBeNull();
      expect(
        await db!.agentPlan.findUnique({ where: { id: 'external' } }),
      ).toMatchObject({ position: 100 });
      expect(await db!.agentRequest.count()).toBe(2);
      expect(
        await db!.agentRunCheckpoint.findUnique({
          where: { runId: 'history' },
        }),
      ).toMatchObject({ version: 999 });
      expect(manager.jobs.size).toBe(0);
    } finally {
      await manager.close();
    }
    expect(
      await db!.agentPlan.findUnique({ where: { id: 'keep' } }),
    ).toMatchObject({ name: 'Database edit' });
  });

  it.each(['plan', 'run', 'request'] as const)(
    'rejects a stale %s change without committing other participants',
    async (kind) => {
      await bootstrapProviders(new DatabaseProviderRepository(db!));
      const archive = new DatabaseManagementArchive(db!);
      await archive.save({
        version: 3,
        characters: [storedCharacter()],
        plans: [
          storedPlan({ characterId: 'actor' }),
          storedPlan({ id: 'other', characterId: 'actor' }),
        ],
        runs: [
          storedRun({
            planId: 'plan',
            characterId: 'actor',
            status: 'completed',
          }),
        ],
        requests: { request: 'plan' },
      });
      const before = (await archive.load())!;
      const after = structuredClone(before);
      after.plans[0].name = 'Local edit';
      after.runs[0].totalTokens = 42;
      delete after.requests.request;
      if (kind === 'plan')
        await db!.agentPlan.update({
          where: { id: 'plan' },
          data: { name: 'Concurrent edit' },
        });
      if (kind === 'run')
        await db!.agentRun.update({
          where: { id: 'run' },
          data: { reason: 'Concurrent edit' },
        });
      if (kind === 'request')
        await db!.agentRequest.update({
          where: { key: 'request' },
          data: { planId: 'other' },
        });
      await expect(
        archive.commit({
          ...after,
          profiles: { actor: { name: 'Uncommitted name' } },
          taskChanges: taskChanges(before, after),
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect((await archive.characters.record('actor')).name).toBe(
        before.characters[0].name,
      );
      expect(
        await db!.agentRun.findUnique({ where: { id: 'run' } }),
      ).toMatchObject({ totalTokens: 0n });
      expect(await db!.tokenUsage.count()).toBe(0);
      expect(
        await db!.agentPlan.findUnique({ where: { id: 'plan' } }),
      ).toMatchObject({
        name: kind === 'plan' ? 'Concurrent edit' : before.plans[0].name,
      });
      expect(
        await db!.agentRequest.findUnique({ where: { key: 'request' } }),
      ).not.toBeNull();
    },
  );

  it('serializes competing task commits and accounts tokens only for the winning transaction', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const archive = new DatabaseManagementArchive(db!);
    await archive.save({
      version: 3,
      characters: [storedCharacter()],
      plans: [storedPlan({ characterId: 'actor' })],
      runs: [
        storedRun({
          planId: 'plan',
          characterId: 'actor',
          status: 'completed',
        }),
      ],
      requests: {},
    });
    const before = (await archive.load())!;
    const changes = [10, 20].map((tokens) => {
      const next = structuredClone(before);
      next.plans[0].spentTokens = tokens;
      next.runs[0].totalTokens = tokens;
      return {
        ...next,
        characters: [],
        taskChanges: taskChanges(before, next),
      };
    });
    const results = await Promise.allSettled(
      changes.map((change) =>
        new DatabaseManagementArchive(db!).commit(change),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { status: 409 } });
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    const tokens = winner === 0 ? 10n : 20n;
    expect(
      await db!.agentPlan.findUnique({ where: { id: 'plan' } }),
    ).toMatchObject({ spentTokens: tokens });
    expect(
      await db!.agentRun.findUnique({ where: { id: 'run' } }),
    ).toMatchObject({ totalTokens: tokens });
    expect(await db!.tokenUsage.findMany()).toMatchObject([{ tokens }]);
  });

  it('rolls back character, plan, execution and usage writes when a later task insert fails', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const archive = new DatabaseManagementArchive(db!);
    await archive.save({
      version: 3,
      characters: [storedCharacter()],
      plans: [storedPlan({ characterId: 'actor' })],
      runs: [
        storedRun({
          planId: 'plan',
          characterId: 'actor',
          status: 'completed',
          requestId: 'same',
        }),
      ],
      requests: {},
    });
    const before = (await archive.load())!;
    const next = structuredClone(before);
    next.plans[0].spentTokens = 10;
    next.runs[0].totalTokens = 10;
    next.runs.push(
      storedRun({
        id: 'duplicate',
        planId: 'plan',
        characterId: 'actor',
        requestId: 'same',
      }),
    );
    await expect(
      archive.commit({
        ...next,
        profiles: { actor: { name: 'Uncommitted' } },
        taskChanges: taskChanges(before, next),
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(await archive.load()).toEqual(before);
    expect(await db!.tokenUsage.count()).toBe(0);
  });

  it('rejects character removal when a new database plan was not included in the detach operation', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const archive = new DatabaseManagementArchive(db!);
    await archive.save({
      version: 3,
      characters: [storedCharacter()],
      plans: [storedPlan({ characterId: 'actor' })],
      runs: [],
      requests: {},
    });
    const before = (await archive.load())!;
    await archive.save({
      ...before,
      plans: [
        ...before.plans,
        storedPlan({ id: 'external', characterId: 'actor' }),
      ],
    });
    const next = structuredClone(before);
    delete next.plans[0].characterId;
    next.plans[0].state = 'paused';
    await expect(
      archive.commit({
        ...next,
        characters: [],
        remove: ['actor'],
        taskChanges: taskChanges(before, next),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await db!.agentCharacter.count()).toBe(1);
    expect(await db!.agentPlan.count({ where: { characterId: 'actor' } })).toBe(
      2,
    );
  });

  it('deletes only explicit task records, preserves ordering gaps and rejects resurrection after a stale update', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const archive = new DatabaseManagementArchive(db!);
    await archive.save({
      version: 3,
      characters: [storedCharacter()],
      plans: [storedPlan({ id: 'first' }), storedPlan({ id: 'second' })],
      runs: [
        storedRun({ id: 'first', planId: 'first' }),
        storedRun({ id: 'second', planId: 'second' }),
      ],
      requests: { first: 'first', second: 'second' },
    });
    const before = (await archive.load())!;
    const next = structuredClone(before);
    next.plans.shift();
    next.runs.shift();
    delete next.requests.first;
    await archive.commit({
      ...next,
      characters: [],
      taskChanges: taskChanges(before, next),
    });
    expect(await db!.agentPlan.findMany()).toMatchObject([
      { id: 'second', position: 1 },
    ]);
    expect(await db!.agentRun.findMany()).toMatchObject([
      { id: 'second', position: 1 },
    ]);
    expect(await db!.agentRequest.findMany()).toMatchObject([
      { key: 'second' },
    ]);
    const stale = structuredClone(before);
    stale.plans[0].name = 'Stale update';
    await expect(
      archive.commit({
        ...stale,
        characters: [],
        taskChanges: taskChanges(before, stale),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await db!.agentPlan.findUnique({ where: { id: 'first' } }),
    ).toBeNull();
  });

  it('checkpoint commits preserve database configuration and omitted offline characters, and never resurrect deletions', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const archive = new DatabaseManagementArchive(db!);
    const actor = storedCharacter();
    await archive.save({
      version: 3,
      characters: [actor, storedCharacter({ id: 'offline' })],
      plans: [],
      runs: [],
      requests: {},
    });
    await db!.agentCharacter.update({
      where: { id: actor.id },
      data: { name: 'Database authority' },
    });
    await archive.commit({
      version: 3,
      characters: [actor],
      plans: [],
      runs: [],
      requests: {},
    });
    expect(await db!.agentCharacter.count()).toBe(2);
    expect((await new CharacterQueries(db!).get(actor.id)).name).toBe(
      'Database authority',
    );
    await archive.commit({
      version: 3,
      characters: [],
      remove: [actor.id],
      plans: [],
      runs: [],
      requests: {},
    });
    await expect(
      archive.commit({
        version: 3,
        characters: [actor],
        plans: [],
        runs: [],
        requests: {},
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await db!.agentCharacter.count()).toBe(1);
  });

  it('retains historical database logs when the runtime window advances', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const archive = new DatabaseManagementArchive(db!);
    const entries = Array.from({ length: 700 }, (_, index) => ({
      time: index,
      text: `entry-${index}`,
    }));
    const actor = storedCharacter({ logEntries: entries });
    await archive.save({
      version: 3,
      characters: [actor],
      plans: [],
      runs: [],
      requests: {},
    });
    const recent = [...entries.slice(-499), { time: 700, text: 'new entry' }];
    const change = {
      version: 3 as const,
      characters: [{ ...actor, logEntries: recent }],
      plans: [],
      runs: [],
      requests: {},
    };
    await archive.commit(change);
    await archive.commit(change);
    const page = await new CharacterQueries(db!).logs(actor.id, 2, 0);
    expect(page).toEqual({
      entries: [{ time: 700, text: 'new entry' }, entries[699]],
      total: 701,
    });
    expect(
      await db!.agentCharacterLog.findUnique({
        where: { characterId_sequence: { characterId: actor.id, sequence: 1 } },
      }),
    ).toMatchObject(entries[0]);
  });

  it('counts offline profiles inside the transaction when concurrent creates reach the limit', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const archive = new DatabaseManagementArchive(db!);
    await archive.save({
      version: 3,
      characters: Array.from({ length: 49 }, (_, index) =>
        storedCharacter({ id: `offline-${index}` }),
      ),
      plans: [],
      runs: [],
      requests: {},
    });
    const results = await Promise.allSettled(
      ['last-a', 'last-b'].map((id) =>
        new DatabaseManagementArchive(db!).commit({
          version: 3,
          characters: [],
          create: storedCharacter({ id }),
          plans: [],
          runs: [],
          requests: {},
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { status: 409 } });
    expect(await db!.agentCharacter.count()).toBe(50);
  });

  it('reads plan queries from committed database rows independently of the in-memory ledger', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const archive = new DatabaseManagementArchive(db!);
    await archive.save({
      version: 3,
      characters: [storedCharacter({ name: 'Database character' })],
      plans: [storedPlan({ characterId: 'actor' })],
      runs: [storedRun({ planId: 'plan', characterId: 'actor' })],
      requests: {},
    });
    const { host } = taskExecutionFixture();
    const tasks = new TaskCoordinator(host, archive.tasks);
    expect(tasks.committedPlans.plans).toHaveLength(0);
    expect((await tasks.planPage({ search: '巡查' })).items[0]).toMatchObject({
      id: 'plan',
      characterName: 'Database character',
    });
    expect(await tasks.publicPlan('plan')).toMatchObject({
      id: 'plan',
      characterName: 'Database character',
    });
    expect((await tasks.publicRuns('actor', 'plan')).items[0]).toMatchObject({
      id: 'run',
      status: 'queued',
    });
    await db!.agentPlan.update({
      where: { id: 'plan' },
      data: { name: 'Changed in database' },
    });
    expect((await tasks.publicPlan('plan')).name).toBe('Changed in database');
    await expect(tasks.publicRuns('other', 'plan')).rejects.toThrow(
      '计划执行角色已改变',
    );
    await expect(tasks.publicPlan('missing')).rejects.toThrow('计划不存在');
  });

  it('reads one recoverable character and its bounded log window without restoring unrelated data', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    await db!.ttsProvider.create({ data: DEFAULT_TTS_PROVIDER });
    const archive = new DatabaseManagementArchive(db!);
    const runtime = createAgentRuntime();
    runtime.ensureTask('Recover only this actor');
    const state = runtime.snapshot();
    const logs = Array.from({ length: 700 }, (_, time) => ({
      time,
      text: `log-${time}`,
    }));
    const actor = storedCharacter({
      currentRunId: 'current',
      runtime: state,
      logEntries: logs,
      voiceServiceId: DEFAULT_TTS_PROVIDER.id,
    });
    await archive.save({
      version: 3,
      characters: [
        actor,
        storedCharacter({
          id: 'unrelated',
          runtime: createAgentRuntime().snapshot(),
        }),
      ],
      plans: [],
      runs: [
        storedRun({
          id: 'current',
          characterId: actor.id,
          status: 'running',
          runtime: state,
        }),
      ],
      requests: {},
    });
    await db!.agentCharacterState.update({
      where: { characterId: 'unrelated' },
      data: { runtimeVersion: 999 },
    });
    await expect(archive.load()).rejects.toMatchObject({ status: 500 });
    expect(await archive.characters.record(actor.id)).toMatchObject({
      id: actor.id,
      currentRunId: 'current',
      runtime: JSON.parse(JSON.stringify(state)),
      logEntries: logs.slice(-500),
    });
    const view = await archive.characters.view(actor.id);
    expect(view).toMatchObject({
      id: actor.id,
      task: { goal: 'Recover only this actor' },
      logEntries: logs.slice(-500),
    });
    for (const key of [
      'runtime',
      'state',
      'currentRunId',
      'taskIdentity',
      'logs',
      'apiKey',
    ])
      expect(view).not.toHaveProperty(key);
    expect(await archive.characters.hasProviderReference('deepseek')).toBe(
      true,
    );
    expect(await archive.characters.hasProviderReference('missing')).toBe(
      false,
    );
    expect(
      await archive.characters.hasVoiceServiceReference(
        DEFAULT_TTS_PROVIDER.id,
      ),
    ).toBe(true);
    expect(await archive.characters.hasVoiceServiceReference('missing')).toBe(
      false,
    );
    await expect(archive.characters.record('missing')).rejects.toMatchObject({
      status: 404,
    });
    await expect(archive.characters.view('missing')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('filters and pages plans in SQL with literal searches and stable page boundaries', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const archive = new DatabaseManagementArchive(db!);
    const plans = Array.from({ length: 24 }, (_, index) =>
      storedPlan({
        id: `plan-${String(index).padStart(2, '0')}`,
        name: `Inspect ${index}`,
        characterId: 'actor',
        characterName: 'Old name',
      }),
    );
    await archive.save({
      version: 3,
      characters: [storedCharacter({ name: 'Current name' })],
      plans: [
        ...plans,
        storedPlan({ id: 'archived', state: 'archived' }),
        storedPlan({
          id: 'unassigned',
          name: 'Literal 100%_path\\file',
          state: 'paused',
          timing: { kind: 'interval', everyMs: 60000 },
          characterName: 'Former actor',
        }),
      ],
      runs: [],
      requests: {},
    });
    const { host } = taskExecutionFixture();
    const tasks = new TaskCoordinator(host, archive.tasks);
    const first = await tasks.planPage({});
    expect(first.total).toBe(25);
    expect(first.items.map((item) => item.id)).toEqual(
      plans.slice(0, 20).map((plan) => plan.id),
    );
    expect(first.nextOffset).toBe(20);
    expect(first.items[0].characterName).toBe('Current name');
    const second = await tasks.planPage({ offset: first.nextOffset });
    expect(second.items.map((item) => item.id)).toEqual([
      ...plans.slice(20).map((plan) => plan.id),
      'unassigned',
    ]);
    expect(second.nextOffset).toBeUndefined();
    expect(
      (await tasks.planPage({ search: 'INSPECT', characterId: 'actor' })).total,
    ).toBe(24);
    for (const search of ['%', '_', '\\', '100%_path\\file']) {
      expect(
        (await tasks.planPage({ search })).items.map((item) => item.id),
      ).toEqual(['unassigned']);
    }
    expect(
      (await tasks.planPage({ state: 'archived' })).items.map(
        (item) => item.id,
      ),
    ).toEqual(['archived']);
    expect(
      (await tasks.planPage({ state: 'unassigned', timing: 'interval' }))
        .items[0],
    ).toMatchObject({
      id: 'unassigned',
      characterName: 'Former actor',
      timing: { kind: 'interval', everyMs: 60000 },
    });
    expect(
      (await tasks.planPage({ state: 'unassigned', characterId: 'actor' }))
        .total,
    ).toBe(0);
    expect(
      (await tasks.planPage({ offset: Number.MAX_SAFE_INTEGER })).items,
    ).toEqual([]);
    await expect(tasks.planPage({ offset: -1 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      tasks.planPage({ state: 'invalid' as 'enabled' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(tasks.taskPlans('missing')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('pages only the requested history and retains active runs, historical actors and current identities', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const archive = new DatabaseManagementArchive(db!);
    const runtime = createAgentRuntime();
    runtime.ensureTask('Current actor task');
    runtime.lease();
    const state = runtime.snapshot();
    state.execution.conversation.audienceExpired = true;
    const runs = Array.from({ length: 24 }, (_, index) =>
      storedRun({
        id: `run-${index}`,
        planId: 'plan',
        characterId: index === 0 ? 'deleted-actor' : 'actor',
        characterName: index === 0 ? 'Deleted actor' : 'Previous name',
        status: index === 0 ? 'blocked' : 'completed',
        runtime: state,
        logs: [`history-${index}`],
        requestId: `private-${index}`,
        lastBatch: 'private-batch',
      }),
    );
    await archive.save({
      version: 3,
      characters: [
        storedCharacter({
          name: 'Current name',
          runtime: state,
          currentRunId: 'run-23',
        }),
        storedCharacter({ id: 'deleted-actor' }),
      ],
      plans: [
        storedPlan({ characterId: 'actor' }),
        storedPlan({ id: 'unrelated' }),
      ],
      runs: [
        ...runs,
        storedRun({
          id: 'chat',
          planId: 'plan',
          characterId: 'actor',
          source: 'chat',
        }),
        storedRun({ id: 'unrelated', planId: 'unrelated', runtime: state }),
      ],
      requests: {},
    });
    await db!.agentCharacter.delete({ where: { id: 'deleted-actor' } });
    // A full archive restore would fail on this unrelated checkpoint.
    await db!.agentRunCheckpoint.update({
      where: { runId: 'unrelated' },
      data: { version: 999 },
    });
    const { host } = taskExecutionFixture();
    const tasks = new TaskCoordinator(host, archive.tasks);
    const first = await tasks.publicRuns('actor', 'plan', 0, true);
    expect(first.total).toBe(24);
    expect(first.items.map((item) => item.id)).toEqual(
      runs
        .slice(4)
        .reverse()
        .map((run) => run.id),
    );
    expect(first.nextOffset).toBe(20);
    expect(first.active).toHaveLength(1);
    expect(first.active[0]).toMatchObject({
      id: 'run-0',
      characterId: 'deleted-actor',
      characterName: 'Deleted actor',
      taskIdentity: null,
      requiresReassignment: true,
    });
    expect(first.items[0]).toMatchObject({
      taskIdentity: runtime.lease(),
      characterName: 'Previous name',
      logs: runs[23].logs,
    });
    for (const key of [
      'runtime',
      'checkpoint',
      'character',
      'accountedTokens',
      'requestId',
      'lastBatch',
      'position',
    ])
      expect(first.items[0]).not.toHaveProperty(key);
    const second = await tasks.taskRuns('actor', 'plan', 20);
    expect(second.items.map((item) => item.id)).toEqual(
      runs
        .slice(0, 4)
        .reverse()
        .map((run) => run.id),
    );
    expect(second.items[0]).not.toHaveProperty('taskIdentity');
    const pastEnd = await tasks.publicRuns(
      undefined,
      'plan',
      Number.MAX_SAFE_INTEGER,
    );
    expect(pastEnd.items).toEqual([]);
    expect(pastEnd.active.map((run) => run.id)).toEqual(['run-0']);
    const plan = await tasks.publicPlan('plan');
    expect(plan).toMatchObject({
      characterName: 'Current name',
      taskIdentity: runtime.lease(),
      latestRun: { id: 'run-23', logs: [] },
    });
    expect(plan.latestRun?.actions).toBeUndefined();
    expect((await tasks.taskPlans('actor')).map((item) => item.id)).toEqual([
      'plan',
    ]);
    await expect(tasks.publicRuns('other', 'plan')).rejects.toMatchObject({
      status: 409,
    });
    await expect(tasks.publicRuns(undefined, 'missing')).rejects.toMatchObject({
      status: 404,
    });
    await expect(tasks.taskRuns('missing', 'plan')).rejects.toMatchObject({
      status: 404,
    });
    await expect(tasks.publicRuns(undefined, 'plan', -1)).rejects.toMatchObject(
      { status: 400 },
    );
  });

  it('queries persisted character details, current checkpoints and log pages without a running manager', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    await db!.ttsProvider.create({ data: DEFAULT_TTS_PROVIDER });
    const runtime = createAgentRuntime();
    runtime.ensureTask('Inspect the world');
    const identity = runtime.lease();
    const state = runtime.snapshot();
    state.character.usage = { calls: 2, tokens: 120, estimated: false };
    state.execution.health.lastResponse = 'Saved reply';
    state.execution.conversation.audienceExpired = true;
    const run = storedRun({
      id: 'current',
      characterId: 'actor',
      status: 'running',
      runtime: state,
    });
    const older = storedCharacter({
      id: 'actor',
      currentRunId: run.id,
      runtime: state,
      voiceServiceId: DEFAULT_TTS_PROVIDER.id,
      logEntries: [
        { text: 'First', time: 100 },
        { text: 'Second', time: 200 },
        { text: 'Legacy latest', time: null },
      ],
    });
    const later = storedRun({
      id: 'later',
      characterId: 'actor',
      scheduledAt: 400,
      coalescedTriggers: 2,
    });
    const earlier = storedRun({
      id: 'earlier',
      characterId: 'actor',
      scheduledAt: 300,
    });
    await new DatabaseManagementArchive(db!).save({
      version: 3,
      characters: [older, storedCharacter({ id: 'newer' })],
      plans: [],
      runs: [run, later, earlier],
      requests: {},
    });
    const queries = new CharacterQueries(db!);
    const detail = await queries.get('actor');
    expect(detail).toMatchObject({
      id: 'actor',
      createdAt: older.createdAt,
      voiceServiceName: DEFAULT_TTS_PROVIDER.name,
      task: { goal: 'Inspect the world' },
      taskIdentity: identity,
      taskExecution: {
        runId: run.id,
        limits: run.snapshot.limits,
        source: run.source,
      },
      usage: state.character.usage,
      lastResponse: 'Saved reply',
      taskRequiresReassignment: true,
    });
    expect(detail.queuedTasks).toEqual([
      {
        id: earlier.id,
        goal: earlier.snapshot.goal,
        scheduledAt: 300,
        coalescedTriggers: 0,
      },
      {
        id: later.id,
        goal: later.snapshot.goal,
        scheduledAt: 400,
        coalescedTriggers: 2,
      },
    ]);
    for (const key of [
      'logEntries',
      'runtime',
      'state',
      'memory',
      'provider',
      'apiKey',
      'position',
    ]) {
      expect(detail).not.toHaveProperty(key);
    }
    const list = await queries.list();
    expect(list.map((item) => item.id)).toEqual(['newer', 'actor']);
    expect(list[1]).toEqual(detail);
    expect(list[0]).toMatchObject({ taskIdentity: null });
    expect(list[0]).not.toHaveProperty('queuedTasks');
    expect(await queries.logs('actor', 2, 0)).toEqual({
      entries: [older.logEntries[2], older.logEntries[1]],
      total: 3,
    });
    expect(await queries.logs('actor', 2, 2)).toEqual({
      entries: [older.logEntries[0]],
      total: 3,
    });
    expect(await queries.logs('actor', 2, 99)).toEqual({
      entries: [],
      total: 3,
    });
    expect(await queries.logs('actor', 2, 1e100)).toEqual({
      entries: [],
      total: 3,
    });
    expect(await queries.logs('newer', 2, 0)).toEqual({
      entries: [],
      total: 0,
    });
    await expect(queries.get('missing')).rejects.toMatchObject({ status: 404 });
    await expect(queries.logs('missing', 2, 0)).rejects.toMatchObject({
      status: 404,
    });

    await db!.agentCharacter.update({
      where: { id: 'actor' },
      data: { name: 'Changed in SQL' },
    });
    expect((await queries.get('actor')).name).toBe('Changed in SQL');
    let written!: () => void;
    const ready = new Promise<void>((resolve) => {
      written = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = db!.$transaction(async (tx) => {
      await tx.agentCharacter.update({
        where: { id: 'actor' },
        data: { name: 'Next commit' },
      });
      written();
      await gate;
    });
    await ready;
    try {
      expect((await queries.get('actor')).name).toBe('Changed in SQL');
    } finally {
      release();
      await saving;
    }
    expect((await queries.get('actor')).name).toBe('Next commit');
  });

  it('serves HTTP character reads from PostgreSQL while keeping uncommitted runtime changes private', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const directory = await mkdtemp(join(tmpdir(), 'voxel-query-test-'));
    process.env.DATABASE_URL = url!;
    process.env.SERVER_PORT = '0';
    process.env.WEB_ORIGIN = 'http://world.test';
    process.env.AGENT_GATEWAY_TOKEN = 'fixture-gateway-token-for-tests';
    const server = await createServer();
    try {
      await server.listen();
      const base = server.httpUrl;
      const headers = {
        Authorization: 'Bearer fixture-gateway-token-for-tests',
        Origin: 'http://world.test',
        'Content-Type': 'application/json',
      };
      const created = await fetch(base + '/ai-characters', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          providerId: 'ollama',
          model: 'qwen2.5:3b',
          name: 'Saved',
          joinWorld: false,
        }),
      });
      expect(created.status).toBe(201);
      const original = await created.json();
      const path = `${base}/ai-characters/${original.id}`;
      const get = async (url: string) => {
        const response = await fetch(url, { headers });
        expect(response.status).toBe(200);
        return response.json();
      };
      expect(await get(path)).toEqual(original);
      expect(server._internals.characters.jobs.size).toBe(0);
      await server._internals.characters.join(original.id);
      await server._internals.characters.settled(original.id);
      const job = server._internals.characters.jobs.get(original.id)!;
      await db!.agentCharacterLog.deleteMany({
        where: { characterId: original.id },
      });
      job.view.logEntries = [];
      job.view.name = 'Unsaved runtime name';
      job.view.logEntries.push({ text: 'Unsaved runtime log', time: 1 });
      job.view.sessionId = 'live-connection';
      expect(await get(path)).toMatchObject({
        name: 'Saved',
        sessionId: 'live-connection',
      });
      await db!.agentCharacter.update({
        where: { id: original.id },
        data: { name: 'SQL name' },
      });
      await db!.agentCharacterLog.createMany({
        data: [
          {
            characterId: original.id,
            sequence: 1,
            text: 'DB first',
            time: 100,
          },
          {
            characterId: original.id,
            sequence: 2,
            text: 'DB latest',
            time: null,
          },
        ],
      });
      const detail = await get(path);
      expect(detail).toMatchObject({
        name: 'SQL name',
      });
      expect(detail).not.toHaveProperty('lastLog');
      expect(detail).not.toHaveProperty('lastLogAt');
      expect(detail).not.toHaveProperty('queuedTasks');
      expect(await get(base + '/ai-characters')).toEqual([detail]);
      const firstPage = await get(path + '/logs?limit=1');
      expect(firstPage).toMatchObject({
        entries: [{ text: 'DB latest', time: null }],
        total: 2,
      });
      const lastPage = await get(
        path + '/logs?limit=1&cursor=' + firstPage.nextCursor,
      );
      expect(lastPage).toEqual({
        entries: [{ text: 'DB first', time: 100 }],
        total: 2,
      });
      server._internals.characters.events.publish('providers');
      expect((await get(path)).resourceVersion).toBe(
        detail.resourceVersion + 1,
      );
      // Test cleanup restores the live object before the normal shutdown save.
      job.view.name = 'Saved';
      job.view.logEntries = [];
      delete job.view.sessionId;
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('enforces current execution ownership and preserves history through reassignment and character deletion', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const runtime = createAgentRuntime().executionSnapshot();
    const plan = storedPlan({ characterId: 'a', characterName: 'A' });
    const first = storedRun({
      id: 'first',
      planId: plan.id,
      characterId: 'a',
      characterName: 'A',
      runtime,
    });
    const second = storedRun({
      id: 'second',
      planId: plan.id,
      characterId: 'a',
      characterName: 'A',
      runtime,
    });
    const foreign = storedRun({ id: 'foreign', characterId: 'b', runtime });
    const snapshot: ManagementArchive = {
      version: 3,
      characters: [
        storedCharacter({ id: 'a', currentRunId: first.id, runtime }),
        storedCharacter({ id: 'b', runtime }),
      ],
      plans: [plan],
      runs: [first, second, foreign],
      requests: { 'a:create': plan.id },
    };
    const archive = new DatabaseManagementArchive(db!);
    await archive.load();
    await archive.save(snapshot);
    // Both referenced Runs exist: the composite FK must reject the wrong owner.
    await expect(
      db!.agentCharacterState.update({
        where: { characterId: 'a' },
        data: { currentRunId: foreign.id },
      }),
    ).rejects.toThrow();
    await expect(
      db!.agentRun.delete({ where: { id: first.id } }),
    ).rejects.toThrow();
    await expect(
      db!.agentRunCheckpoint.delete({ where: { runId: first.id } }),
    ).rejects.toThrow();
    snapshot.characters[0].currentRunId = second.id;
    snapshot.runs = [second, foreign];
    await archive.save(snapshot); // Removes the formerly selected Run before updating state.
    expect(await new DatabaseManagementArchive(db!).load()).toEqual(snapshot);
    // A plan may be reassigned while ended history still belongs to the original actor.
    plan.characterId = 'b';
    plan.characterName = 'B';
    second.status = 'completed';
    await archive.save(snapshot);
    expect(
      (await db!.agentRun.findUniqueOrThrow({ where: { id: second.id } }))
        .characterId,
    ).toBe('a');
    const failed = structuredClone(snapshot);
    failed.characters = failed.characters.filter(
      (character) => character.id !== 'a',
    );
    failed.requests.invalid = 'missing-plan';
    await expect(archive.save(failed)).rejects.toThrow();
    expect(await new DatabaseManagementArchive(db!).load()).toEqual(snapshot);
    snapshot.characters = snapshot.characters.filter(
      (character) => character.id !== 'a',
    );
    await archive.save(snapshot);
    expect(
      await db!.agentRun.findUniqueOrThrow({ where: { id: second.id } }),
    ).toMatchObject({
      characterId: null,
      characterIdSnapshot: 'a',
      characterName: 'A',
      planId: plan.id,
    });
    const restarted = new DatabaseManagementArchive(db!);
    const restored = (await restarted.load())!;
    expect(restored).toEqual(snapshot);
    await restarted.save(restored);
    expect(
      await db!.agentRequest.findUnique({ where: { key: 'a:create' } }),
    ).toMatchObject({ planId: plan.id });
    expect(
      await db!.tokenUsage.count({ where: { characterId: 'a' } }),
    ).toBeGreaterThanOrEqual(0);
  });

  it('rejects dangling task references and duplicate manual requests while preserving scoped idempotency', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const p = storedPlan({ id: 'p', characterId: 'a' });
    const q = storedPlan({ id: 'q', characterId: 'a' });
    const snapshot: ManagementArchive = {
      version: 3,
      characters: [storedCharacter({ id: 'a' })],
      plans: [p, q],
      runs: [
        storedRun({ planId: p.id, characterId: 'a', requestId: 'manual' }),
      ],
      requests: { 'a:create': p.id },
    };
    const archive = new DatabaseManagementArchive(db!);
    await archive.load();
    await archive.save(snapshot);
    await expect(
      db!.agentPlan.update({
        where: { id: p.id },
        data: { characterId: 'missing' },
      }),
    ).rejects.toThrow();
    await expect(
      db!.agentRun.update({
        where: { id: 'run' },
        data: { planId: 'missing' },
      }),
    ).rejects.toThrow();
    await expect(
      db!.agentRequest.create({ data: { key: 'invalid', planId: 'missing' } }),
    ).rejects.toThrow();
    await expect(
      db!.agentRequest.create({ data: { key: 'a:create', planId: q.id } }),
    ).rejects.toThrow();
    await expect(
      db!.agentPlan.delete({ where: { id: p.id } }),
    ).rejects.toThrow();
    const duplicate = structuredClone(snapshot);
    duplicate.runs.push({ ...duplicate.runs[0], id: 'duplicate' });
    await expect(archive.save(duplicate)).rejects.toThrow();
    const changed = structuredClone(snapshot);
    changed.requests['a:create'] = q.id;
    await expect(archive.save(changed)).rejects.toThrow();
    expect(await new DatabaseManagementArchive(db!).load()).toEqual(snapshot);
    snapshot.runs.push(
      storedRun({
        id: 'other-plan',
        planId: q.id,
        characterId: 'a',
        requestId: 'manual',
      }),
    );
    snapshot.runs.push(
      storedRun({ id: 'chat', characterId: 'a', source: 'chat' }),
    );
    await archive.save(snapshot);
    expect(await new DatabaseManagementArchive(db!).load()).toEqual(snapshot);
    // Request mappings follow their plan's lifetime, not the actor's lifetime.
    await db!.agentRequest.create({ data: { key: 'temporary', planId: q.id } });
    await db!.agentRun.delete({ where: { id: 'other-plan' } });
    await db!.agentPlan.delete({ where: { id: q.id } });
    expect(
      await db!.agentRequest.findUnique({ where: { key: 'temporary' } }),
    ).toBeNull();
  });

  it('protects persisted TTS references and stores an explicitly cleared voice as SQL NULL', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    await db!.ttsProvider.create({ data: DEFAULT_TTS_PROVIDER });
    const archive = new DatabaseManagementArchive(db!);
    await archive.load();
    const snapshot: ManagementArchive = {
      version: 3,
      characters: [
        storedCharacter({ id: 'a', voiceServiceId: DEFAULT_TTS_PROVIDER.id }),
      ],
      plans: [],
      runs: [],
      requests: {},
    };
    await archive.save(snapshot);
    await expect(
      new DatabaseVoiceServicePersistence(db!).transaction((tx) =>
        tx.remove(DEFAULT_TTS_PROVIDER.id),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      db!.agentCharacter.update({
        where: { id: 'a' },
        data: { voiceServiceId: 'missing' },
      }),
    ).rejects.toThrow();
    snapshot.characters[0].voiceServiceId = '';
    await archive.save(snapshot);
    expect(
      (await db!.agentCharacter.findUniqueOrThrow({ where: { id: 'a' } }))
        .voiceServiceId,
    ).toBeNull();
    await new DatabaseVoiceServicePersistence(db!).transaction((tx) =>
      tx.remove(DEFAULT_TTS_PROVIDER.id),
    );
    expect(await db!.ttsProvider.count()).toBe(0);
  });

  it('persists one ASR assignment per use and rolls back conflicting assignments with profile changes', async () => {
    const persistence = new DatabaseAsrServicePersistence(db!);
    const store = new AsrService(persistence);

    const a = await store.save({
      ...DEFAULT_WHISPER_ASR,
      provider: 'whisper',
      name: 'A',
    });
    const b = await store.save({
      ...DEFAULT_WHISPER_ASR,
      provider: 'whisper',
      name: 'B',
    });
    await store.assign('chat', a.id);
    await store.assign('clip', a.id);
    await store.assign('chat', b.id);
    const restored = new AsrService(persistence);

    expect((await restored.assignments()).chat?.id).toBe(b.id);
    expect((await restored.assignments()).clip?.id).toBe(a.id);
    await expect(
      db!.asrAssignment.create({ data: { use: 'chat', providerId: a.id } }),
    ).rejects.toThrow();
    await expect(
      db!.asrAssignment.create({
        data: { use: 'spatial', providerId: 'missing' },
      }),
    ).rejects.toThrow();
    await expect(
      db!
        .$executeRaw`INSERT INTO "AsrAssignment" ("use", "providerId") VALUES ('unknown', ${a.id})`,
    ).rejects.toThrow();
    const before = await persistence.load();
    await expect(
      persistence.save(
        before.map((service) => ({
          ...service,
          name: 'uncommitted',
          uses: ['chat'],
        })),
      ),
    ).rejects.toThrow();
    expect(await persistence.load()).toEqual(before);
    await restored.remove(a.id);
    expect(
      await db!.asrAssignment.findUnique({ where: { use: 'clip' } }),
    ).toBeNull();
    // Unassigned uses retain the existing Whisper fallback after deletion/restart.
    const after = new AsrService(persistence);

    expect((await after.assignments()).clip?.id).toBe(b.id);
    expect((await after.assignments()).chat?.id).toBe(b.id);
  });

  it('keeps concurrent catalog writes from independent instances and reads later database changes', async () => {
    const asrA = new AsrService(new DatabaseAsrServicePersistence(db!));
    const asrB = new AsrService(new DatabaseAsrServicePersistence(db!));
    const [first, second] = await Promise.all([
      asrA.save({
        ...DEFAULT_WHISPER_ASR,
        provider: 'whisper',
        name: 'First ASR',
      }),
      asrB.save({
        ...DEFAULT_WHISPER_ASR,
        provider: 'whisper',
        name: 'Second ASR',
      }),
    ]);
    const asrBefore = await db!.asrProvider.findUniqueOrThrow({
      where: { id: second.id },
    });
    await Promise.all([
      asrA.assign('chat', first.id),
      asrB.assign('clip', second.id),
    ]);
    expect(await asrA.list()).toHaveLength(2);
    expect(
      (await db!.asrProvider.findUniqueOrThrow({ where: { id: second.id } }))
        .updatedAt,
    ).toEqual(asrBefore.updatedAt);
    expect(await asrB.assignments()).toMatchObject({
      chat: { id: first.id },
      clip: { id: second.id },
    });
    await db!.asrProvider.update({
      where: { id: first.id },
      data: { name: 'Changed in database' },
    });
    expect(await asrA.get(first.id)).toMatchObject({
      name: 'Changed in database',
    });

    const ttsA = new TtsService(new DatabaseVoiceServicePersistence(db!));
    const ttsB = new TtsService(new DatabaseVoiceServicePersistence(db!));
    const [voiceA, voiceB] = await Promise.all([
      ttsA.save({ name: 'First TTS', type: 'browser', voice: 'one' }),
      ttsB.save({ name: 'Second TTS', type: 'browser', voice: 'two' }),
    ]);
    expect(new Set((await ttsA.list()).map((voice) => voice.id))).toEqual(
      new Set([voiceA.id, voiceB.id]),
    );
    const voiceBefore = await db!.ttsProvider.findUniqueOrThrow({
      where: { id: voiceB.id },
    });
    await ttsA.save({ ...voiceA, name: 'Renamed TTS' }, voiceA.id);
    expect(
      (await db!.ttsProvider.findUniqueOrThrow({ where: { id: voiceB.id } }))
        .updatedAt,
    ).toEqual(voiceBefore.updatedAt);
    await db!.ttsProvider.update({
      where: { id: voiceA.id },
      data: { name: 'Changed TTS' },
    });
    expect(await ttsB.get(voiceA.id)).toMatchObject({ name: 'Changed TTS' });

    const providersA = new DatabaseProviderRepository(db!);
    const providersB = new DatabaseProviderRepository(db!);
    const [providerA, providerB] = await Promise.all([
      providersA.save({ name: 'First model', type: 'ollama' }),
      providersB.save({ name: 'Second model', type: 'ollama' }),
    ]);
    expect(
      new Set((await providersA.list()).map((provider) => provider.id)),
    ).toEqual(new Set([providerA.id, providerB.id]));
    await expect(
      providersB.save({ id: providerA.id, name: 'Collision', type: 'ollama' }),
    ).rejects.toMatchObject({ status: 409 });
    await db!.agentProvider.update({
      where: { id: providerA.id },
      data: { name: 'Changed model' },
    });
    expect(await providersB.getRuntime(providerA.id)).toMatchObject({
      name: 'Changed model',
    });
  });

  it('enforces the TTS catalog limit across concurrent instances', async () => {
    await db!.ttsProvider.createMany({
      data: Array.from({ length: 19 }, (_, index) => ({
        ...DEFAULT_TTS_PROVIDER,
        id: `existing-${index}`,
        position: index,
      })),
    });
    const first = new TtsService(new DatabaseVoiceServicePersistence(db!));
    const second = new TtsService(new DatabaseVoiceServicePersistence(db!));
    const results = await Promise.allSettled([
      first.save({ name: 'First', type: 'browser', voice: 'one' }),
      second.save({ name: 'Second', type: 'browser', voice: 'two' }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(await db!.ttsProvider.count()).toBe(20);
  });

  it('queries structured tasks, clears optional values and preserves token accounting after restart', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const plan = storedPlan({
      characterId: 'actor',
      characterName: 'Actor',
      revision: 2,
      imported: false,
      limitsMode: 'inherit',
      totalTokenBudgetEnabled: false,
      timing: { kind: 'weekly', time: '09:30', weekdays: [1, 5] },
      nextRunAt: 1793491200123,
      spentTokens: 3_000_000_000,
    });
    const run = storedRun({
      planId: plan.id,
      planRevision: 2,
      characterId: 'actor',
      characterName: 'Actor',
      source: 'scheduled',
      status: 'completed',
      startedAt: 1793491200800,
      finishedAt: 1793491200999,
      eventId: 'event',
      coalescedTriggers: 0,
      lastTriggerAt: 1793491200789,
      requestId: 'request',
      lastBatch: 'batch',
      totalTokens: 3_000_000_000,
      accountedTokens: 3_000_000_000,
      actions: [],
      logs: ['done'],
      requiresReassignment: false,
    });
    const snapshot: ManagementArchive = {
      version: 3,
      characters: [storedCharacter({ id: 'actor', name: 'Actor' })],
      plans: [plan],
      runs: [run],
      requests: {},
    };
    const archive = new DatabaseManagementArchive(db!);
    await archive.load();
    await archive.save(snapshot);
    expect(
      await db!.agentPlan.findMany({
        where: {
          state: 'enabled',
          nextRunAt: { lte: new Date(1793491200123) },
        },
        select: { id: true, scheduleKind: true, spentTokens: true },
      }),
    ).toEqual([
      { id: plan.id, scheduleKind: 'weekly', spentTokens: 3_000_000_000n },
    ]);
    expect(
      await db!.agentRun.count({
        where: { planId: plan.id, status: 'completed' },
      }),
    ).toBe(1);
    expect(await new DatabaseManagementArchive(db!).load()).toEqual(snapshot);
    delete plan.characterId;
    delete plan.characterName;
    delete plan.nextRunAt;
    delete plan.limitsMode;
    delete plan.totalTokenBudgetEnabled;
    plan.state = 'paused';
    delete run.characterId;
    delete run.actions;
    delete run.startedAt;
    delete run.finishedAt;
    delete run.lastTriggerAt;
    delete run.eventId;
    delete run.requestId;
    delete run.lastBatch;
    await archive.save(snapshot);
    const restored = new DatabaseManagementArchive(db!);
    const loaded = (await restored.load())!;
    expect(loaded).toEqual(snapshot);
    // Repeat settlement of the restored checkpoint must not charge its usage again.
    expect(
      settleTaskUsage(loaded.runs[0], 3_000_000_000, loaded.plans[0]),
    ).toBe(0);
    expect(
      settleTaskUsage(loaded.runs[0], 3_000_000_007, loaded.plans[0]),
    ).toBe(7);
    await restored.save(loaded);
    expect(
      (await new DatabaseManagementArchive(db!).load())!.plans[0].spentTokens,
    ).toBe(3_000_000_007);
    const invalid = structuredClone(loaded);
    invalid.plans[0].goal = 'must roll back';
    invalid.runs[0].totalTokens = Number.MAX_SAFE_INTEGER + 1;
    await expect(restored.save(invalid)).rejects.toThrow(
      '无法保存 Agent 数据库记录',
    );
    expect(await new DatabaseManagementArchive(db!).load()).toEqual(loaded);
  });

  it('updates state and appends or trims logs without rewriting configuration or retained logs', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const archive = new DatabaseManagementArchive(db!);
    await archive.load();
    const record = {
      id: 'split',
      name: 'Split',
      providerId: 'deepseek',
      status: 'stopped',
      runtime: createAgentRuntime().snapshot(),
      logEntries: [
        { time: null, text: 'first' },
        { time: 100, text: 'second' },
      ],
    };
    const snapshot = {
      version: 3,
      characters: [record],
      plans: [],
      runs: [],
      requests: {},
    } as unknown as ManagementArchive;
    await archive.save(snapshot);
    const revisions = () => db!.$queryRaw<
      Array<{ kind: string; revision: string }>
    >`
      SELECT 'config' AS kind, xmin::text AS revision FROM "AgentCharacter" WHERE id = 'split'
      UNION ALL SELECT 'state', xmin::text FROM "AgentCharacterState" WHERE "characterId" = 'split'
      UNION ALL SELECT 'retained-log', xmin::text FROM "AgentCharacterLog" WHERE "characterId" = 'split' AND sequence = 2
      ORDER BY kind
    `;
    const before = await revisions();
    record.logEntries.push({ time: 101, text: 'third' });
    await archive.save(snapshot);
    expect(await revisions()).toEqual(before);
    record.logEntries.shift();
    await archive.save(snapshot);
    expect(await revisions()).toEqual(before);
    expect(
      await db!.agentCharacterLog.findMany({ orderBy: { sequence: 'asc' } }),
    ).toEqual([
      { characterId: 'split', sequence: 2, time: 100, text: 'second' },
      { characterId: 'split', sequence: 3, time: 101, text: 'third' },
    ]);
    const restored = new DatabaseManagementArchive(db!);
    const loaded = (await restored.load())!;
    expect(loaded).toEqual(snapshot);
    await restored.save(loaded);
    expect(await revisions()).toEqual(before);
    loaded.characters[0].status = 'idle';
    await restored.save(loaded);
    const after = await revisions();
    expect(after.filter((r) => r.kind !== 'state')).toEqual(
      before.filter((r) => r.kind !== 'state'),
    );
    expect(after.find((r) => r.kind === 'state')).not.toEqual(
      before.find((r) => r.kind === 'state'),
    );
    // A later FK failure must roll back all three earlier character writes.
    const invalid = structuredClone(loaded);
    invalid.characters[0].name = 'Uncommitted';
    invalid.characters[0].status = 'failed';
    invalid.characters[0].logEntries.push({ time: 102, text: 'uncommitted' });
    invalid.characters.push({
      ...invalid.characters[0],
      id: 'invalid',
      providerId: 'missing',
    });
    await expect(restored.save(invalid)).rejects.toThrow(
      '无法保存 Agent 数据库记录',
    );
    expect(await new DatabaseManagementArchive(db!).load()).toEqual(loaded);
    await restored.save(loaded);
    expect(await revisions()).toEqual(after);
    loaded.characters = [];
    await restored.save(loaded);
    expect(await db!.agentCharacterState.count()).toBe(0);
    expect(await db!.agentCharacterLog.count()).toBe(0);
  });

  it('stores execution checkpoints once and resumes them with the latest character memory', async () => {
    await bootstrapProviders(new DatabaseProviderRepository(db!));
    const runtime = createAgentRuntime();
    runtime.ensureTask('Keep progress');
    runtime.stageControl(
      { type: 'pause' },
      { kind: 'operator' },
      testAgentConfig(),
    );
    const checkpoint = runtime.executionSnapshot();
    checkpoint.execution.checkpoint.unknownEffect = {
      id: 'effect',
      name: 'edit',
      state: 'unknown',
    };
    const current = structuredClone(checkpoint);
    current.character = {
      conversation: {
        exchanges: { public: ['latest conversation'] },
        lastChatAt: 500,
      },
      usage: { calls: 10, tokens: 1000, estimated: false },
      inbox: {
        version: 1,
        events: [
          {
            id: 'new-input',
            kind: 'plan',
            state: 'pending',
            at: 500,
            audience: 'public',
          },
        ],
      },
    };
    const snapshot = {
      version: 3,
      characters: [
        {
          id: 'actor',
          providerId: 'deepseek',
          name: 'Actor',
          status: 'stopped',
          currentRunId: 'run',
          runtime: current,
          logEntries: [],
        },
      ],
      plans: [],
      runs: [
        storedRun({
          id: 'run',
          characterId: 'actor',
          status: 'paused',
          runtime: checkpoint,
        }),
      ],
      requests: {},
    } as unknown as ManagementArchive;
    const archive = new DatabaseManagementArchive(db!);
    await archive.load();
    await archive.save(snapshot);
    const storedState = await db!.agentCharacterState.findUniqueOrThrow({
      where: { characterId: 'actor' },
    });
    expect(storedState).toMatchObject({
      runtimeVersion: 4,
      memory: current.character,
      standby: null,
    });
    expect(storedState).not.toHaveProperty('runtime');
    expect(
      await db!.agentRun.findUniqueOrThrow({ where: { id: 'run' } }),
    ).not.toHaveProperty('runtime');
    expect(
      await db!.agentRunCheckpoint.findUniqueOrThrow({
        where: { runId: 'run' },
      }),
    ).toEqual({ runId: 'run', version: 4, execution: checkpoint.execution });
    const revisions = () => db!.$queryRaw<
      Array<{ kind: string; revision: string }>
    >`
      SELECT 'state' AS kind, xmin::text AS revision FROM "AgentCharacterState" WHERE "characterId" = 'actor'
      UNION ALL SELECT 'run', xmin::text FROM "AgentRun" WHERE id = 'run'
      UNION ALL SELECT 'checkpoint', xmin::text FROM "AgentRunCheckpoint" WHERE "runId" = 'run'
      ORDER BY kind
    `;
    const before = await revisions();
    // A checkpoint-only update must not rewrite character memory or Run metadata.
    checkpoint.execution.health.lastResponse = 'new execution progress';
    current.execution = structuredClone(checkpoint.execution);
    await archive.save(snapshot);
    const after = await revisions();
    expect(after.filter((r) => r.kind !== 'checkpoint')).toEqual(
      before.filter((r) => r.kind !== 'checkpoint'),
    );
    expect(after.find((r) => r.kind === 'checkpoint')).not.toEqual(
      before.find((r) => r.kind === 'checkpoint'),
    );
    const restored = new DatabaseManagementArchive(db!);
    const loaded = (await restored.load())!;
    expect(loaded).toEqual(snapshot);
    await restored.save(loaded);
    expect(await revisions()).toEqual(after);
    const resumed = createAgentRuntime({ state: loaded.characters[0].runtime });
    resumed.resumeExecution(loaded.runs[0].runtime!, testAgentConfig());
    expect(resumed.snapshot().character).toEqual(current.character);
    expect(resumed.view().task).toMatchObject({
      goal: 'Keep progress',
      status: 'running',
    });
    expect(resumed.snapshot().execution.checkpoint.unknownEffect).toEqual(
      checkpoint.execution.checkpoint.unknownEffect,
    );

    // A request error occurs after both memory and checkpoint writes in the transaction.
    const failed = structuredClone(loaded);
    failed.characters[0].runtime!.character.conversation.lastChatAt = 999;
    failed.runs[0].runtime!.execution.health.lastResponse = 'uncommitted';
    failed.characters[0].runtime!.execution = structuredClone(
      failed.runs[0].runtime!.execution,
    );
    failed.requests.bad = null as unknown as string;
    await expect(restored.save(failed)).rejects.toThrow(
      '无法保存 Agent 数据库记录',
    );
    expect(await new DatabaseManagementArchive(db!).load()).toEqual(loaded);
    expect(await revisions()).toEqual(after);
    await restored.save(loaded);
    expect(await revisions()).toEqual(after);

    // Incoherent references must fail rather than silently discard current progress.
    const mismatched = structuredClone(loaded);
    mismatched.characters[0].runtime!.execution.health.lastResponse =
      'different';
    await expect(restored.save(mismatched)).rejects.toThrow(
      '无法保存 Agent 数据库记录',
    );
    await expect(
      db!.agentRunCheckpoint.delete({ where: { runId: 'run' } }),
    ).rejects.toThrow();
    await expect(
      db!.agentRun.update({
        where: { id: 'run' },
        data: { characterId: 'another' },
      }),
    ).rejects.toThrow();
    expect(await new DatabaseManagementArchive(db!).load()).toEqual(loaded);
    loaded.characters = [];
    loaded.runs = [];
    await restored.save(loaded);
    expect(await db!.agentRunCheckpoint.count()).toBe(0);
  });

  it('restarts a managed character from its Run checkpoint without replaying unknown actions', async () => {
    const providers = new DatabaseProviderRepository(db!);
    await bootstrapProviders(providers);
    const manager = new AICharacterManager(
      providers,
      'ws://fixture',
      new DatabaseManagementArchive(db!),
    );
    let id: string;
    try {
      await manager.load();
      id = (
        await manager.create({
          name: 'Restart',
          providerId: 'ollama',
          model: 'qwen2.5:3b',
          joinWorld: false,
        })
      ).id;
      await manager.flush();
    } finally {
      await manager.close();
    }
    const archive = new DatabaseManagementArchive(db!);
    const saved = (await archive.load())!;
    const runtime = createAgentRuntime({ state: saved.characters[0].runtime });
    runtime.ensureTask('Recover progress');
    const lease = runtime.lease();
    const state = runtime.snapshot();
    state.character.conversation.exchanges = { public: ['latest memory'] };
    state.execution.checkpoint.pi = {
      version: 3,
      taskId: lease.id,
      revision: lease.revision,
      taskStartedAt: lease.startedAt,
      audience: 'public',
      messages: [],
      inFlight: { id: 'edit', name: 'edit', state: 'executing' },
    };
    runtime.restore(state);
    const plan = newPlan(
      {
        name: 'Recovery',
        goal: 'Recover progress',
        timing: { kind: 'immediate' },
        timeZone: 'UTC',
        limits: DEFAULT_TASK_LIMITS,
        totalTokenBudget: 500000,
      },
      Date.now(),
    );
    const run = newRun(plan, Date.now(), 'chat');
    delete run.planId;
    run.characterId = id!;
    run.task = runtime.view().task;
    run.runtime = runtime.executionSnapshot();
    saved.runs.push(run);
    saved.characters[0].currentRunId = run.id;
    saved.characters[0].runtime = runtime.snapshot();
    await archive.save(saved);
    const restarted = new AICharacterManager(
      providers,
      'ws://fixture',
      new DatabaseManagementArchive(db!),
    );
    try {
      await restarted.load();
      expect((await new CharacterQueries(db!).list())[0]).toMatchObject({
        id: id!,
        status: 'stopped',
        task: { goal: 'Recover progress', status: 'paused' },
      });
      const restored = (await new DatabaseManagementArchive(db!).load())!;
      expect(
        restored.characters[0].runtime!.character.conversation.exchanges,
      ).toEqual({ public: ['latest memory'] });
      expect(restored.runs[0].runtime!.character).toEqual({ conversation: {} });
      expect(
        restored.runs[0].runtime!.execution.checkpoint.unknownEffect,
      ).toMatchObject({ id: 'edit', state: 'unknown' });
      expect(restored.characters[0].runtime!.execution).toEqual(
        restored.runs[0].runtime!.execution,
      );
    } finally {
      await restarted.close();
    }
  });

  it('starts TTS with Piper, preserves ordered services and secrets, and remembers an empty catalog', async () => {
    await db!.ttsProvider.create({ data: DEFAULT_TTS_PROVIDER });
    const store = new TtsService(new DatabaseVoiceServicePersistence(db!));

    expect((await store.list()).map((voice) => voice.id)).toEqual([
      'local-default',
    ]);
    const cloud = await store.save({
      name: 'Cloud',
      type: 'compatible',
      baseUrl: 'https://speech.example/v1',
      model: 'test-tts',
      voice: 'alloy',
      speed: 1,
      apiKey: 'tts-secret',
    });
    expect(JSON.stringify(await store.list())).not.toContain('tts-secret');
    expect((await store.get(cloud.id)).apiKey).toBe('tts-secret');
    await store.save({ ...cloud, name: 'Cloud Updated', apiKey: '' }, cloud.id);
    const restored = new TtsService(new DatabaseVoiceServicePersistence(db!));

    expect((await restored.list()).map((voice) => voice.id)).toEqual([
      'local-default',
      cloud.id,
    ]);
    expect(await restored.get(cloud.id)).toMatchObject({
      name: 'Cloud Updated',
      apiKey: 'tts-secret',
    });
    const offGuard = domainEvents.on(
      'tts.service.removing',
      ({ serviceId }) => {
        if (serviceId === cloud.id)
          throw new AppError('语音服务仍被引用。', 409);
      },
    );
    try {
      await expect(restored.remove(cloud.id)).rejects.toMatchObject({
        status: 409,
      });
    } finally {
      offGuard();
    }
    await restored.remove(cloud.id);
    await restored.remove('local-default');
    const empty = new TtsService(new DatabaseVoiceServicePersistence(db!));

    expect(await empty.list()).toEqual([]);
  });

  it.each([
    ['openai', 'gpt-live-transcribe'],
    ['gemini', 'gemini-3.5-transcribe-live'],
  ] as const)(
    'round-trips %s realtime ASR profiles through PostgreSQL',
    async (provider, model) => {
      const store = new AsrService(new DatabaseAsrServicePersistence(db!));

      const service = await store.save({
        provider,
        model,
        name: 'Live',
        apiKey: 'test-private-key',
      });
      await store.assign('chat', service.id);
      const restored = new AsrService(new DatabaseAsrServicePersistence(db!));

      expect(await restored.get(service.id)).toMatchObject({
        provider,
        model,
        apiKey: 'test-private-key',
      });
      expect((await restored.assignments()).chat).toMatchObject({
        id: service.id,
        provider,
      });
      expect(JSON.stringify(await restored.list())).not.toContain(
        'test-private-key',
      );
    },
  );

  it('persists ASR profiles, masks credentials, and protects active recognition', async () => {
    const store = new AsrService(new DatabaseAsrServicePersistence(db!));

    expect(await store.list()).toEqual([]);
    const whisper = await store.save({
      ...DEFAULT_WHISPER_ASR,
      provider: 'whisper',
      name: 'Whisper',
    });
    const cloud = await store.save({
      ...DEFAULT_BAILIAN_ASR,
      name: 'Bailian',
      apiKey: 'asr-secret',
    });
    expect(JSON.stringify(await store.list())).not.toContain('asr-secret');
    await store.save(
      { ...DEFAULT_BAILIAN_ASR, name: 'Bailian Updated', apiKey: '' },
      cloud.id,
    );
    const restored = new AsrService(new DatabaseAsrServicePersistence(db!));

    expect((await restored.list()).map((service) => service.id)).toEqual([
      whisper.id,
      cloud.id,
    ]);
    expect(await restored.get(cloud.id)).toMatchObject({
      name: 'Bailian Updated',
      apiKey: 'asr-secret',
    });
    const active = await restored.acquire(cloud.id);
    await expect(restored.remove(cloud.id)).rejects.toMatchObject({
      status: 409,
    });
    active.release();
    await restored.remove(cloud.id);
    expect((await restored.list()).map((service) => service.id)).toEqual([
      whisper.id,
    ]);
  });

  it('keeps audio catalogs unchanged on database write failure without exposing details', async () => {
    const failingDb = {
      $transaction: async () => {
        throw new Error('postgresql://user:secret@localhost/test');
      },
    } as unknown as PrismaClient;
    const tts = new TtsService(new DatabaseVoiceServicePersistence(failingDb));

    const voiceError = await tts
      .save({ name: 'Local', type: 'piper', speed: 1 })
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(voiceError?.message).toBe('无法保存语音服务数据库配置。');

    const asr = new AsrService({
      load: async () => [],
      update: async (change) => {
        const { values, result } = change([]);
        await new DatabaseAsrServicePersistence(failingDb).save(values);
        return result;
      },
    });

    const asrError = await asr
      .save({
        ...DEFAULT_BAILIAN_ASR,
        name: 'Bailian',
        apiKey: 'secret',
      })
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(asrError?.message).toBe('无法保存 ASR 数据库配置。');
    expect(await asr.list()).toEqual([]);
  });

  it('seeds once, persists secrets privately, and preserves an intentionally empty catalog', async () => {
    const providers = new DatabaseProviderRepository(db!);
    await bootstrapProviders(providers);
    await providers.save(
      {
        name: 'DeepSeek',
        type: 'deepseek',
        apiKey: 'database-only-key',
        defaultModel: 'deepseek-flash',
      },
      'deepseek',
    );
    expect(await providers.get('deepseek')).not.toHaveProperty('apiKey');
    expect((await providers.get('deepseek')).hasApiKey).toBe(true);
    expect(
      (await db!.agentProvider.findUnique({ where: { id: 'deepseek' } }))
        ?.apiKey,
    ).toBe('database-only-key');

    const reloaded = new DatabaseProviderRepository(db!);
    expect((await reloaded.getRuntime('deepseek')).apiKey).toBe(
      'database-only-key',
    );
    await reloaded.remove('deepseek');
    await reloaded.save({ id: 'custom', name: 'Custom', type: 'ollama' });
    await new DatabaseProviderRepository(db!).list();
    expect(
      (await db!.agentProvider.findMany({ orderBy: { position: 'asc' } })).map(
        (row) => row.id,
      ),
    ).toEqual(['ollama', 'custom']);
    await reloaded.remove('ollama');
    await reloaded.remove('custom');
    const empty = new DatabaseProviderRepository(db!);
    expect(await empty.list()).toEqual([]);
  });

  it('commits ordered entity rows and checkpoints without rewriting unchanged history', async () => {
    const providers = new DatabaseProviderRepository(db!);
    await bootstrapProviders(providers);
    const archive = new DatabaseManagementArchive(db!);
    expect(await archive.load()).toBeUndefined();
    const runtime = createAgentRuntime();
    runtime.ensureTask('work');
    const checkpoint = runtime.executionSnapshot();
    checkpoint.execution.health.lastResponse = 'checkpoint-1';
    const first = {
      version: 3,
      characters: [
        {
          id: 'agent-1',
          name: 'Agent',
          providerId: 'deepseek',
          status: 'stopped',
          logEntries: [],
          runtime: structuredClone(checkpoint),
          currentRunId: 'run-a',
        },
      ],
      plans: [
        storedPlan({ id: 'plan-b', goal: 'second' }),
        storedPlan({ id: 'plan-a', goal: 'first' }),
      ],
      runs: [
        storedRun({
          id: 'run-b',
          characterId: 'agent-1',
          planId: 'plan-b',
          status: 'completed',
        }),
        storedRun({
          id: 'run-a',
          characterId: 'agent-1',
          planId: 'plan-a',
          status: 'running',
          runtime: structuredClone(checkpoint),
        }),
      ],
      requests: { 'agent-1:request': 'plan-a' },
    } as unknown as ManagementArchive;
    await archive.save(first);
    const loaded = await new DatabaseManagementArchive(db!).load();
    expect(loaded).toEqual(first);

    const unchangedHistory = await db!.$queryRaw<Array<{ xmin: string }>>`
      SELECT xmin::text AS xmin FROM "AgentRun" WHERE id = 'run-b'
    `;
    first.runs[1].runtime!.execution.health.lastResponse = 'checkpoint-2';
    first.characters[0].runtime!.execution = structuredClone(
      first.runs[1].runtime!.execution,
    );
    await archive.save(first);
    expect(
      await db!.$queryRaw<Array<{ xmin: string }>>`
        SELECT xmin::text AS xmin FROM "AgentRun" WHERE id = 'run-b'
      `,
    ).toEqual(unchangedHistory);
    expect(
      (await new DatabaseManagementArchive(db!).load())?.runs[1].runtime,
    ).toEqual(first.runs[1].runtime);
    const restoredArchive = new DatabaseManagementArchive(db!);
    const restored = (await restoredArchive.load())!;
    const checkpointRevision = await db!.$queryRaw<Array<{ xmin: string }>>`
      SELECT xmin::text AS xmin FROM "AgentRun" WHERE id = 'run-a'
    `;
    await restoredArchive.save(restored);
    expect(
      await db!.$queryRaw<Array<{ xmin: string }>>`
        SELECT xmin::text AS xmin FROM "AgentRun" WHERE id = 'run-a'
      `,
    ).toEqual(checkpointRevision);
    await expect(providers.remove('deepseek')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('rolls back earlier row updates if a later write violates the provider reference', async () => {
    const providers = new DatabaseProviderRepository(db!);
    await bootstrapProviders(providers);
    const archive = new DatabaseManagementArchive(db!);
    await archive.load();
    const original = {
      version: 3,
      characters: [
        { id: 'a', name: 'Before', providerId: 'deepseek', logEntries: [] },
      ],
      plans: [],
      runs: [],
      requests: {},
    } as unknown as ManagementArchive;
    await archive.save(original);
    const invalid = {
      ...original,
      characters: [
        { ...original.characters[0], name: 'Uncommitted' },
        { id: 'b', name: 'Invalid', providerId: 'missing' },
      ],
    } as ManagementArchive;
    await expect(archive.save(invalid)).rejects.toThrow(
      '无法保存 Agent 数据库记录',
    );
    expect(
      (await new DatabaseManagementArchive(db!).load())?.characters,
    ).toEqual(original.characters);
    await archive.save({
      ...original,
      characters: [{ ...original.characters[0], name: 'After' }],
    });
    expect(
      (await new DatabaseManagementArchive(db!).load())?.characters[0].name,
    ).toBe('After');
  });

  it('does not publish a character when the database rejects its joint commit', async () => {
    const providers = new DatabaseProviderRepository(db!);
    await bootstrapProviders(providers);
    const manager = new AICharacterManager(
      providers,
      'ws://fixture',
      new DatabaseManagementArchive(db!),
    );
    await manager.load();
    const changes: string[] = [];
    manager.events.on((change) => changes.push(change.resource));
    const removed = await db!.agentProvider.delete({ where: { id: 'ollama' } });
    try {
      await expect(
        manager.create({
          name: 'Uncommitted',
          providerId: 'ollama',
          model: 'qwen2.5:3b',
          joinWorld: false,
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(await new CharacterQueries(db!).list()).toEqual([]);
      expect(changes).toEqual([]);
      expect(await db!.agentCharacter.count()).toBe(0);
    } finally {
      await db!.agentProvider.create({ data: removed });
      await manager.close();
    }
  });

  it('starts from an empty database and restores saved state through the production server assembly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'voxel-database-test-'));
    process.env.DATABASE_URL = url!;
    process.env.SERVER_PORT = '0';
    process.env.WEB_ORIGIN = 'http://127.0.0.1:5173';
    process.env.AGENT_GATEWAY_TOKEN = 'fixture-gateway-token-for-tests';
    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      await db!.ttsProvider.create({ data: DEFAULT_TTS_PROVIDER });
      server = await createServer();
      await server.listen();
      expect(await new CharacterQueries(db!).list()).toEqual([]);
      expect(await server._internals.providers.list()).toHaveLength(0);
      expect(
        (await server._internals.voiceServices.list()).map(
          (service) => service.id,
        ),
      ).toEqual(['local-default']);
      expect(await server._internals.asrSettings.list()).toEqual([]);
      await server._internals.providers.save(
        { name: 'Ollama', type: 'ollama', defaultModel: 'qwen2.5:3b' },
        'ollama',
      );
      const revision = server._internals.characters.storageRevision;
      const created = await server._internals.characters.create({
        name: 'Database Agent',
        providerId: 'ollama',
        joinWorld: false,
        voiceReplies: true,
        voiceServiceId: 'local-default',
      });
      await server._internals.characters.flush(revision);
      await server.close();
      // Persisted references protect a voice even while the server is offline.
      await expect(db!.ttsProvider.deleteMany()).rejects.toThrow();
      await db!.agentCharacter.update({
        where: { id: created.id },
        data: { voiceReplies: false, voiceServiceId: null },
      });
      await db!.ttsProvider.deleteMany();
      server = await createServer();
      await server.listen();
      expect(await server._internals.providers.list()).toHaveLength(1);
      expect(await server._internals.voiceServices.list()).toEqual([]);
      expect(await server._internals.asrSettings.list()).toEqual([]);
      expect(await new CharacterQueries(db!).list()).toEqual([
        expect.objectContaining({
          id: created.id,
          name: 'Database Agent',
          voiceReplies: false,
          voiceServiceId: '',
        }),
      ]);
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('persists player identities and chat messages with recipients in database', async () => {
    const { ChatStore } = await import('../src/modules/chat');
    const chatStore = new ChatStore(db!);

    const aliceId = await chatStore.recordPlayer({
      name: 'Alice',
      kind: 'human',
    });
    const bobId = await chatStore.recordPlayer({
      name: 'Bob',
      kind: 'human',
    });

    expect(aliceId).toBeDefined();
    expect(bobId).toBeDefined();

    await chatStore.recordMessage({
      senderName: 'Alice',
      senderKind: 'human',
      scope: 'private',
      kind: 'text',
      text: 'Secret message for Bob',
      recipients: ['Bob'],
    });

    const messages = await db!.chatMessage.findMany({
      include: { recipients: true },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].senderName).toBe('Alice');
    expect(messages[0].text).toBe('Secret message for Bob');
    expect(messages[0].recipients).toHaveLength(1);
    expect(messages[0].recipients[0].playerId).toBe(bobId);
  });
});
