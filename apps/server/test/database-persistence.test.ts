import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseClient } from '../src/persistence/database-client';
import { DatabaseProviderRepository } from '../src/modules/providers/persistence/database-repository';
import { bootstrapProviders } from '../src/modules/providers/bootstrap';
import { DatabaseManagementArchive } from '../src/persistence/database-archive';
import { AICharacterManager } from '../src/modules/ai-characters';
import type { ManagementArchive } from '../src/persistence/archive';
import { createServer } from '../src/server';
import { env } from '../src/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.TEST_DATABASE_URL;
const db = url ? createDatabaseClient(url) : undefined;

describe.skipIf(!url)('PostgreSQL provider and management persistence', () => {
  beforeEach(async () => {
    await db!.agentRequest.deleteMany();
    await db!.agentRun.deleteMany();
    await db!.agentPlan.deleteMany();
    await db!.agentCharacter.deleteMany();
    await db!.agentProvider.deleteMany();
    await db!.agentProviderState.deleteMany();
    await db!.blockEdit.deleteMany();
    await db!.world.deleteMany();
  });
  afterAll(async () => db?.$disconnect());

  it('seeds once, persists secrets privately, and does not reseed an intentionally empty catalog', async () => {
    const providers = new DatabaseProviderRepository(db!);
    await bootstrapProviders(providers, {
      DEEPSEEK_API_KEY: 'database-only-key',
    });
    expect(providers.get('deepseek')).not.toHaveProperty('apiKey');
    expect(providers.get('deepseek').hasApiKey).toBe(true);
    expect(
      (await db!.agentProvider.findUnique({ where: { id: 'deepseek' } }))
        ?.apiKey,
    ).toBe('database-only-key');

    const reloaded = new DatabaseProviderRepository(db!);
    expect(await reloaded.load()).toBe(true);
    expect(reloaded.getRuntime('deepseek').apiKey).toBe('database-only-key');
    await reloaded.remove('deepseek');
    await reloaded.save({ id: 'custom', name: 'Custom', type: 'ollama' });
    expect(await new DatabaseProviderRepository(db!).load()).toBe(true);
    expect(
      (await db!.agentProvider.findMany({ orderBy: { position: 'asc' } })).map(
        (row) => row.id,
      ),
    ).toEqual(['ollama', 'custom']);
    await reloaded.remove('ollama');
    await reloaded.remove('custom');
    const empty = new DatabaseProviderRepository(db!);
    await bootstrapProviders(empty, { DEEPSEEK_API_KEY: 'must-not-seed' });
    expect(empty.list()).toEqual([]);
  });

  it('commits ordered entity rows and checkpoints without rewriting unchanged history', async () => {
    const providers = new DatabaseProviderRepository(db!);
    await bootstrapProviders(providers);
    const archive = new DatabaseManagementArchive(db!);
    expect(await archive.load()).toBeUndefined();
    const first = {
      version: 3,
      characters: [
        {
          id: 'agent-1',
          name: 'Agent',
          providerId: 'deepseek',
          status: 'stopped',
          runtime: { task: { current: { goal: 'work' } } },
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
          runtime: { memory: 'checkpoint-1' },
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
    first.runs[1].runtime = {
      memory: 'checkpoint-2',
    } as unknown as (typeof first.runs)[1]['runtime'];
    await archive.save(first);
    expect(
      await db!.$queryRaw<Array<{ xmin: string }>>`
        SELECT xmin::text AS xmin FROM "AgentRun" WHERE id = 'run-b'
      `,
    ).toEqual(unchangedHistory);
    expect(
      (await new DatabaseManagementArchive(db!).load())?.runs[1].runtime,
    ).toEqual({ memory: 'checkpoint-2' });
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
      characters: [{ id: 'a', name: 'Before', providerId: 'deepseek' }],
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
      undefined,
      undefined,
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
      PORT: '0',
      HOST: '127.0.0.1',
      WEB_ORIGIN: 'http://127.0.0.1:5173',
      VOICE_PROVIDER: 'mock',
      AGENT_GATEWAY_TOKEN: 'fixture-gateway-token-for-tests',
      AGENT_GATEWAY_TOKEN_FILE: join(directory, 'gateway-token'),
    });
    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      server = await createServer({ config });
      await server.listen();
      expect(server.characters.publicList()).toEqual([]);
      expect(server.providers.list()).toHaveLength(2);
      await server.providers.save(
        { name: 'Ollama', type: 'ollama', defaultModel: 'qwen2.5:3b' },
        'ollama',
      );
      const revision = server.characters.storageRevision;
      const created = server.characters.create({
        name: 'Database Agent',
        providerId: 'ollama',
        joinWorld: false,
      });
      await server.characters.flush(revision);
      await server.close();
      server = await createServer({ config });
      await server.listen();
      expect(server.providers.list()).toHaveLength(2);
      expect(server.characters.publicList()).toEqual([
        expect.objectContaining({ id: created.id, name: 'Database Agent' }),
      ]);
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
