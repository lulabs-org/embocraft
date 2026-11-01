import { createAgentRuntime } from '@voxel/agent-runtime';
import { testAgentConfig } from '../../../tests/support/agent-config';
import type { PrismaClient } from '@prisma/client';
import {
  DEFAULT_BAILIAN_ASR,
  DEFAULT_WHISPER_ASR,
  DEFAULT_TASK_LIMITS,
} from '@voxel/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/core/config';
import { createDatabaseClient } from '../src/core/database/client';
import { AICharacterManager } from '../src/modules/ai-characters';
import { AsrSettingsStore } from '../src/modules/asr/persistence/asr-settings-store';
import { DatabaseAsrServicePersistence } from '../src/modules/asr/persistence/database-asr-services';
import { DatabaseVoiceServicePersistence } from '../src/modules/tts/persistence/database-voice-services';
import { VoiceServiceStore } from '../src/modules/tts/persistence/voice-service-store';
import { bootstrapProviders } from './helpers/provider-seed';
import { DatabaseProviderRepository } from '../src/modules/providers';
import { DEFAULT_TTS_PROVIDER } from '../prisma/seed-data';
import type { ManagementArchive } from '../src/persistence/archive';
import { DatabaseManagementArchive } from '../src/persistence/database-archive';
import { createServer } from '../src/server';
import { newPlan, newRun } from '../src/modules/tasks';

const url = process.env.TEST_DATABASE_URL;
const db = url ? createDatabaseClient(url) : undefined;

describe.skipIf(!url)('PostgreSQL provider and management persistence', () => {
  beforeEach(async () => {
    await db!.ttsProvider.deleteMany();
    await db!.asrProvider.deleteMany();
    await db!.agentRequest.deleteMany();
    await db!.agentRun.deleteMany();
    await db!.agentPlan.deleteMany();
    await db!.agentCharacter.deleteMany();
    await db!.agentProvider.deleteMany();
    await db!.blockEdit.deleteMany();
    await db!.world.deleteMany();
  });
  afterAll(async () => db?.$disconnect());

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
        {
          id: 'run',
          characterId: 'actor',
          status: 'paused',
          runtime: checkpoint,
        },
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
      (await db!.agentRun.findUniqueOrThrow({ where: { id: 'run' } })).data,
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
    await db!.agentRunCheckpoint.delete({ where: { runId: 'run' } });
    await expect(new DatabaseManagementArchive(db!).load()).rejects.toThrow(
      '无法读取 Agent 数据库记录',
    );
    await db!.agentRunCheckpoint.create({
      data: {
        runId: 'run',
        version: 4,
        execution: JSON.parse(JSON.stringify(checkpoint.execution)),
      },
    });
    await db!.agentRun.update({
      where: { id: 'run' },
      data: { data: { id: 'run', characterId: 'another' } },
    });
    await expect(new DatabaseManagementArchive(db!).load()).rejects.toThrow(
      '无法读取 Agent 数据库记录',
    );
    // Restore the test row before exercising cascade deletion through the archive.
    await db!.agentRun.update({
      where: { id: 'run' },
      data: { data: { id: 'run', characterId: 'actor', status: 'paused' } },
    });
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
      id = manager.create({
        name: 'Restart',
        providerId: 'ollama',
        model: 'qwen2.5:3b',
        joinWorld: false,
      }).id;
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
      expect(restarted.publicList()[0]).toMatchObject({
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
    const store = new VoiceServiceStore(
      new DatabaseVoiceServicePersistence(db!),
    );
    await store.load();
    expect(store.list().map((voice) => voice.id)).toEqual(['local-default']);
    const cloud = await store.save({
      name: 'Cloud',
      type: 'compatible',
      baseUrl: 'https://speech.example/v1',
      model: 'test-tts',
      voice: 'alloy',
      speed: 1,
      apiKey: 'tts-secret',
    });
    expect(JSON.stringify(store.list())).not.toContain('tts-secret');
    expect(store.get(cloud.id).apiKey).toBe('tts-secret');
    await store.save({ ...cloud, name: 'Cloud Updated', apiKey: '' }, cloud.id);
    const restored = new VoiceServiceStore(
      new DatabaseVoiceServicePersistence(db!),
    );
    await restored.load();
    expect(restored.list().map((voice) => voice.id)).toEqual([
      'local-default',
      cloud.id,
    ]);
    expect(restored.get(cloud.id)).toMatchObject({
      name: 'Cloud Updated',
      apiKey: 'tts-secret',
    });
    restored.bind('actor', cloud.id);
    await expect(restored.remove(cloud.id, () => false)).rejects.toMatchObject({
      status: 409,
    });
    restored.unbind('actor');
    await restored.remove(cloud.id, () => false);
    await restored.remove('local-default', () => false);
    const empty = new VoiceServiceStore(
      new DatabaseVoiceServicePersistence(db!),
    );
    await empty.load();
    expect(empty.list()).toEqual([]);
  });

  it('persists ASR profiles, masks credentials, and protects active recognition', async () => {
    const store = new AsrSettingsStore(new DatabaseAsrServicePersistence(db!));
    await store.load();
    expect(store.list()).toEqual([]);
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
    expect(JSON.stringify(store.list())).not.toContain('asr-secret');
    await store.save(
      { ...DEFAULT_BAILIAN_ASR, name: 'Bailian Updated', apiKey: '' },
      cloud.id,
    );
    const restored = new AsrSettingsStore(
      new DatabaseAsrServicePersistence(db!),
    );
    await restored.load();
    expect(restored.list().map((service) => service.id)).toEqual([
      whisper.id,
      cloud.id,
    ]);
    expect(restored.get(cloud.id)).toMatchObject({
      name: 'Bailian Updated',
      apiKey: 'asr-secret',
    });
    const active = restored.acquire(cloud.id);
    await expect(restored.remove(cloud.id)).rejects.toMatchObject({
      status: 409,
    });
    active.release();
    await restored.remove(cloud.id);
    expect(restored.list().map((service) => service.id)).toEqual([whisper.id]);
  });

  it('keeps audio catalogs unchanged on database write failure without exposing details', async () => {
    const failingDb = {
      $transaction: async () => {
        throw new Error('postgresql://user:secret@localhost/test');
      },
    } as unknown as PrismaClient;
    const tts = new VoiceServiceStore({
      load: async () => [],
      save: (values) =>
        new DatabaseVoiceServicePersistence(failingDb).save(values),
    });
    await tts.load();
    const voiceError = await tts
      .save({ name: 'Local', type: 'piper', speed: 1 })
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(voiceError?.message).toBe('无法保存语音服务数据库配置。');
    expect(tts.list()).toEqual([]);

    const asr = new AsrSettingsStore({
      load: async () => [],
      save: (values) =>
        new DatabaseAsrServicePersistence(failingDb).save(values),
    });
    await asr.load();
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
    expect(asr.list()).toEqual([]);
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
    expect(providers.get('deepseek')).not.toHaveProperty('apiKey');
    expect(providers.get('deepseek').hasApiKey).toBe(true);
    expect(
      (await db!.agentProvider.findUnique({ where: { id: 'deepseek' } }))
        ?.apiKey,
    ).toBe('database-only-key');

    const reloaded = new DatabaseProviderRepository(db!);
    await reloaded.load();
    expect(reloaded.getRuntime('deepseek').apiKey).toBe('database-only-key');
    await reloaded.remove('deepseek');
    await reloaded.save({ id: 'custom', name: 'Custom', type: 'ollama' });
    await new DatabaseProviderRepository(db!).load();
    expect(
      (await db!.agentProvider.findMany({ orderBy: { position: 'asc' } })).map(
        (row) => row.id,
      ),
    ).toEqual(['ollama', 'custom']);
    await reloaded.remove('ollama');
    await reloaded.remove('custom');
    const empty = new DatabaseProviderRepository(db!);
    await empty.load();
    expect(empty.list()).toEqual([]);
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
        { id: 'plan-b', goal: 'second' },
        { id: 'plan-a', goal: 'first' },
      ],
      runs: [
        {
          id: 'run-b',
          characterId: 'agent-1',
          planId: 'plan-b',
          status: 'completed',
        },
        {
          id: 'run-a',
          characterId: 'agent-1',
          planId: 'plan-a',
          status: 'running',
          runtime: structuredClone(checkpoint),
        },
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
      const revision = manager.storageRevision;
      manager.create({
        name: 'Uncommitted',
        providerId: 'ollama',
        model: 'qwen2.5:3b',
        joinWorld: false,
      });
      await expect(manager.flush(revision)).rejects.toThrow(
        '无法保存 Agent 数据库记录',
      );
      expect(manager.publicList()).toEqual([]);
      expect(changes).toEqual([]);
      expect(await db!.agentCharacter.count()).toBe(0);
    } finally {
      await db!.agentProvider.create({ data: removed });
      await manager.close();
    }
  });

  it('starts from an empty database and restores saved state through the production server assembly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'voxel-database-test-'));
    const config = env.readServer({
      DATABASE_URL: url!,
      SERVER_PORT: '0',
      SERVER_HOST: '127.0.0.1',
      WEB_ORIGIN: 'http://127.0.0.1:5173',
      AGENT_GATEWAY_TOKEN: 'fixture-gateway-token-for-tests',
      AGENT_GATEWAY_TOKEN_FILE: join(directory, 'gateway-token'),
    });
    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      await db!.ttsProvider.create({ data: DEFAULT_TTS_PROVIDER });
      server = await createServer({ config });
      await server.listen();
      expect(server.characters.publicList()).toEqual([]);
      expect(server.providers.list()).toHaveLength(0);
      expect(server.voiceServices.list().map((service) => service.id)).toEqual([
        'local-default',
      ]);
      expect(server.asrSettings.list()).toEqual([]);
      await server.providers.save(
        { name: 'Ollama', type: 'ollama', defaultModel: 'qwen2.5:3b' },
        'ollama',
      );
      const revision = server.characters.storageRevision;
      const created = server.characters.create({
        name: 'Database Agent',
        providerId: 'ollama',
        joinWorld: false,
        voiceReplies: true,
        voiceServiceId: 'local-default',
      });
      await server.characters.flush(revision);
      await server.close();
      // An old or deleted voice ID must not stop character restoration.
      await db!.ttsProvider.deleteMany();
      server = await createServer({ config });
      await server.listen();
      expect(server.providers.list()).toHaveLength(1);
      expect(server.voiceServices.list()).toEqual([]);
      expect(server.asrSettings.list()).toEqual([]);
      expect(server.characters.publicList()).toEqual([
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
});
