import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { createAgentRuntime } from '@voxel/agent-runtime';
import type { TaskTiming } from '@voxel/shared';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseManagementArchive } from '../src/persistence/database-archive';
import { storedPlan, storedRun } from './helpers/task-records';

const url = process.env.TEST_DATABASE_URL;
const migrationName = '20261101040000_structure_plans_runs';
const migrations = new URL('../prisma/migrations/', import.meta.url);
const migration = await readFile(
  new URL(`${migrationName}/migration.sql`, migrations),
  'utf8',
);

describe.skipIf(!url)('structured task migration', () => {
  let client: Client;
  let db: PrismaClient | undefined;
  let schema: string;

  beforeEach(async () => {
    schema = `task_migration_${randomUUID().replaceAll('-', '')}`;
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    // Exercise the actual preceding migration chain, not a simplified substitute.
    for (const name of (await readdir(migrations)).sort()) {
      if (name >= migrationName) break;
      await client.query(
        await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'),
      );
    }
  });

  afterEach(async () => {
    await db?.$disconnect();
    db = undefined;
    await client.query('ROLLBACK');
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  });

  async function insert<T extends { id: string }>(
    table: 'AgentPlan' | 'AgentRun',
    record: T,
    position = 0,
  ) {
    await client.query(
      `INSERT INTO "${table}" (id, position, data) VALUES ($1, $2, $3::jsonb)`,
      [record.id, position, JSON.stringify(record)],
    );
  }

  it('backfills all schedules, optional settings, large usage and checkpoints and drops both data columns', async () => {
    const timings: TaskTiming[] = [
      { kind: 'immediate' },
      { kind: 'once', at: 1793491200123 },
      { kind: 'interval', everyMs: 60000 },
      { kind: 'daily', time: '09:15' },
      { kind: 'weekly', time: '18:30', weekdays: [1, 3, 5] },
    ];
    const plans = timings.map((timing, position) =>
      storedPlan({
        id: `plan-${position}`,
        timing,
        ...(position === 0
          ? {}
          : {
              characterId: 'actor',
              characterName: '角色',
              revision: 3,
              imported: false,
              limitsMode: 'inherit',
              totalTokenBudgetEnabled: false,
              nextRunAt: 1793491300123,
              spentTokens: 3_000_000_000,
            }),
      }),
    );
    const runs = [
      storedRun({
        id: 'full',
        planId: plans[1].id,
        planRevision: 3,
        characterId: 'actor',
        characterName: '角色',
        source: 'scheduled',
        startedAt: 1793491200890,
        finishedAt: 1793491200999,
        eventId: 'event',
        coalescedTriggers: 0,
        lastTriggerAt: 1793491200789,
        totalTokens: 3_000_000_001,
        accountedTokens: 3_000_000_000,
        logs: ['first', 'second'],
        task: {
          goal: '检查世界',
          status: 'completed',
          summary: '完成',
          reason: '',
          calls: 1,
          tokens: 100,
          estimated: false,
          startedAt: 1793491200890,
          elapsedMs: 109,
        },
        actions: [
          {
            startedAt: 1793491200891,
            batchId: 'batch',
            call: 1,
            index: 0,
            kind: 'inspect',
            status: 'completed',
            detail: 'ok',
          },
        ],
        requestId: 'request',
        lastBatch: 'batch',
        requiresReassignment: false,
      }),
      storedRun({ id: 'chat', source: 'chat', actions: [] }),
      storedRun({
        id: 'legacy',
        source: 'legacy',
        characterName: 'deleted actor',
      }),
    ];
    for (const [position, plan] of plans.entries()) {
      // A derived latestRun copy must not be retained as a second source of truth.
      await insert('AgentPlan', { ...plan, latestRun: runs[0] }, position);
    }
    for (const [position, run] of runs.entries())
      await insert('AgentRun', run, position);
    const runtime = createAgentRuntime().executionSnapshot();
    await client.query(
      'INSERT INTO "AgentRunCheckpoint" ("runId", version, execution) VALUES ($1, 4, $2::jsonb)',
      ['full', JSON.stringify(runtime.execution)],
    );
    await client.query("SET TIME ZONE 'Pacific/Honolulu'");
    await client.query(migration);
    const columns = await client.query(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name IN ('AgentPlan', 'AgentRun') AND column_name = 'data'`,
      [schema],
    );
    expect(columns.rows).toEqual([]);
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url! }, { schema }),
    });
    const archive = new DatabaseManagementArchive(db);
    const loaded = await archive.load();
    expect(loaded).toEqual({
      version: 3,
      characters: [],
      plans,
      runs: [{ ...runs[0], runtime }, ...runs.slice(1)],
      requests: {},
    });
    // Check that first save after upgrade does not rewrite or alter the backfill.
    const revisions = () =>
      client.query('SELECT id, xmin::text FROM "AgentRun" ORDER BY id');
    const before = (await revisions()).rows;
    await archive.save(loaded!);
    expect((await revisions()).rows).toEqual(before);
  });

  it.each([
    ['AgentPlan', { unknownSetting: true }],
    ['AgentPlan', { id: 'different' }],
    ['AgentPlan', { createdAt: 1793491200123.25 }],
    ['AgentPlan', { state: null }],
    ['AgentRun', { unknownSetting: true }],
    ['AgentRun', { accountedTokens: '100' }],
    ['AgentRun', { scheduledAt: 1793491200789.25 }],
    ['AgentRun', { source: null }],
    ['AgentPlan', { spentTokens: -1 }],
    ['AgentRun', { totalTokens: Number.MAX_SAFE_INTEGER + 1 }],
  ] as const)(
    'rolls back both tables when %s cannot be migrated losslessly (%j)',
    async (table, patch) => {
      const plan = storedPlan();
      const run = storedRun();
      await insert('AgentPlan', plan);
      await insert('AgentRun', run);
      await client.query(`UPDATE "${table}" SET data = data || $1::jsonb`, [
        JSON.stringify(patch),
      ]);
      const beforePlan = (await client.query('SELECT * FROM "AgentPlan"')).rows;
      const beforeRun = (await client.query('SELECT * FROM "AgentRun"')).rows;
      await expect(client.query(migration)).rejects.toThrow();
      await client.query('ROLLBACK');
      expect((await client.query('SELECT * FROM "AgentPlan"')).rows).toEqual(
        beforePlan,
      );
      expect((await client.query('SELECT * FROM "AgentRun"')).rows).toEqual(
        beforeRun,
      );
      // No added columns survived the failed transaction.
      expect(Object.keys(beforePlan[0]).sort()).toEqual([
        'data',
        'id',
        'position',
      ]);
      expect(Object.keys(beforeRun[0]).sort()).toEqual([
        'data',
        'id',
        'position',
      ]);
    },
  );
});
