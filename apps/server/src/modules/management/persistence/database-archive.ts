import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../../core/errors/app-error';
import type { ArchivePort, ManagementArchive } from '../domain/archive';
import type { TaskPlan } from '@voxel/shared';

type SavedRow = {
  id: string;
  position: number;
  serialized: string;
  providerId?: string;
};
type SavedSnapshot = {
  characters: Map<string, SavedRow>;
  plans: Map<string, SavedRow>;
  runs: Map<string, SavedRow>;
  requests: Map<string, string>;
};

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : item,
  );
}

function rows<T extends { id: string }>(
  values: T[],
  providerId?: (value: T) => string,
): Map<string, SavedRow> {
  return new Map(
    values.map((value, position) => [
      value.id,
      {
        id: value.id,
        position,
        serialized: stableJson(value),
        ...(providerId ? { providerId: providerId(value) } : {}),
      },
    ]),
  );
}

function snapshot(archive: ManagementArchive): SavedSnapshot {
  return {
    characters: rows(archive.characters, (character) => character.providerId),
    plans: rows(archive.plans),
    runs: rows(archive.runs),
    requests: new Map(Object.entries(archive.requests)),
  };
}

function changed(current: SavedRow, previous?: SavedRow): boolean {
  return (
    !previous ||
    current.position !== previous.position ||
    current.serialized !== previous.serialized ||
    current.providerId !== previous.providerId
  );
}

function json(row: SavedRow): Prisma.InputJsonValue {
  return JSON.parse(row.serialized) as Prisma.InputJsonValue;
}

/** Commits one character/task snapshot as a transaction of changed rows. */
export class DatabaseManagementArchive implements ArchivePort {
  private committed: SavedSnapshot = snapshot({
    version: 3,
    characters: [],
    plans: [],
    runs: [],
    requests: {},
  });

  constructor(private readonly db: PrismaClient) {}

  async load(): Promise<ManagementArchive | undefined> {
    try {
      const [characters, plans, runs, requests] = await Promise.all([
        this.db.agentCharacter.findMany({ orderBy: { position: 'asc' } }),
        this.db.agentPlan.findMany({ orderBy: { position: 'asc' } }),
        this.db.agentRun.findMany({ orderBy: { position: 'asc' } }),
        this.db.agentRequest.findMany(),
      ]);
      const archive: ManagementArchive = {
        version: 3,
        characters: characters.map(
          (row) => row.data as ManagementArchive['characters'][number],
        ),
        plans: plans.map((row) => row.data as TaskPlan),
        runs: runs.map((row) => row.data as ManagementArchive['runs'][number]),
        requests: Object.fromEntries(
          requests.map((row) => [row.key, row.planId]),
        ),
      };
      this.committed = snapshot(archive);
      return characters.length || plans.length || runs.length || requests.length
        ? archive
        : undefined;
    } catch {
      throw new AppError('无法读取 Agent 数据库记录。', 500);
    }
  }

  async save(archive: ManagementArchive): Promise<void> {
    const next = snapshot(archive);
    const before = this.committed;
    try {
      await this.db.$transaction(
        async (tx) => {
          for (const key of before.requests.keys())
            if (!next.requests.has(key))
              await tx.agentRequest.delete({ where: { key } });
          for (const [id] of before.runs)
            if (!next.runs.has(id)) await tx.agentRun.delete({ where: { id } });
          for (const [id] of before.plans)
            if (!next.plans.has(id))
              await tx.agentPlan.delete({ where: { id } });
          for (const [id] of before.characters)
            if (!next.characters.has(id))
              await tx.agentCharacter.delete({ where: { id } });

          for (const row of next.characters.values()) {
            if (!changed(row, before.characters.get(row.id))) continue;
            await tx.agentCharacter.upsert({
              where: { id: row.id },
              create: {
                id: row.id,
                providerId: row.providerId!,
                position: row.position,
                data: json(row),
              },
              update: {
                providerId: row.providerId!,
                position: row.position,
                data: json(row),
              },
            });
          }
          for (const row of next.plans.values()) {
            if (!changed(row, before.plans.get(row.id))) continue;
            await tx.agentPlan.upsert({
              where: { id: row.id },
              create: { id: row.id, position: row.position, data: json(row) },
              update: { position: row.position, data: json(row) },
            });
          }
          for (const row of next.runs.values()) {
            if (!changed(row, before.runs.get(row.id))) continue;
            await tx.agentRun.upsert({
              where: { id: row.id },
              create: { id: row.id, position: row.position, data: json(row) },
              update: { position: row.position, data: json(row) },
            });
          }
          for (const [key, planId] of next.requests) {
            if (before.requests.get(key) === planId) continue;
            await tx.agentRequest.upsert({
              where: { key },
              create: { key, planId },
              update: { planId },
            });
          }
        },
        { maxWait: 10000, timeout: 30000 },
      );
      this.committed = next;
    } catch {
      throw new AppError('无法保存 Agent 数据库记录。', 500);
    }
  }
}
