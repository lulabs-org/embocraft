import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../core/errors/app-error';
import type { ArchivePort, ManagementArchive } from './archive';
import {
  captureCharacter,
  restoreCharacter,
  saveCharacter,
  type SavedCharacter,
} from './character-storage';
import { stableJson } from './stable-json';
import { captureRun, restoreRun, saveRun, type SavedRun } from './run-storage';

type SavedRow = {
  id: string;
  position: number;
  serialized: string;
};
type SavedSnapshot = {
  characters: Map<string, SavedCharacter>;
  plans: Map<string, SavedRow>;
  runs: Map<string, SavedRun>;
  requests: Map<string, string>;
};

function rows<T extends { id: string }>(values: T[]): Map<string, SavedRow> {
  return new Map(
    values.map((value, position) => [
      value.id,
      {
        id: value.id,
        position,
        serialized: stableJson(value),
      },
    ]),
  );
}

function snapshot(
  archive: ManagementArchive,
  previous?: SavedSnapshot,
): SavedSnapshot {
  const runs = new Map(archive.runs.map((run) => [run.id, run]));
  for (const character of archive.characters) {
    if (
      character.runtime &&
      (character.runtime.version !== 4 ||
        !character.runtime.character ||
        !character.runtime.execution)
    )
      throw new Error('Unsupported character runtime.');
    if (character.currentRunId) {
      const run = runs.get(character.currentRunId);
      if (
        !character.runtime ||
        !run?.runtime ||
        run.characterId !== character.id ||
        stableJson(run.runtime.execution) !==
          stableJson(character.runtime.execution)
      )
        throw new Error(
          'Current execution checkpoint is missing, mismatched or belongs to another character.',
        );
    } else if (character.runtime?.execution.task.current) {
      throw new Error('A task execution must belong to a Run.');
    }
  }
  return {
    characters: new Map(
      archive.characters.map((record, position) => [
        record.id,
        captureCharacter(record, position, previous?.characters.get(record.id)),
      ]),
    ),
    plans: rows(archive.plans),
    runs: new Map(
      archive.runs.map((run, position) => [run.id, captureRun(run, position)]),
    ),
    requests: new Map(Object.entries(archive.requests)),
  };
}

function changed(current: SavedRow, previous?: SavedRow): boolean {
  return (
    !previous ||
    current.position !== previous.position ||
    current.serialized !== previous.serialized
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
        this.db.agentCharacter.findMany({
          orderBy: { position: 'asc' },
          include: { state: true, logs: { orderBy: { sequence: 'asc' } } },
        }),
        this.db.agentPlan.findMany({ orderBy: { position: 'asc' } }),
        this.db.agentRun.findMany({
          orderBy: { position: 'asc' },
          include: { checkpoint: true },
        }),
        this.db.agentRequest.findMany(),
      ]);
      const restoredRuns = runs.map(restoreRun);
      const byRunId = new Map(restoredRuns.map((run) => [run.id, run]));
      const archive: ManagementArchive = {
        version: 3,
        characters: characters.map((row) => restoreCharacter(row, byRunId)),
        plans: plans.map(
          (row) => row.data as ManagementArchive['plans'][number],
        ),
        runs: restoredRuns,
        requests: Object.fromEntries(
          requests.map((row) => [row.key, row.planId]),
        ),
      };
      this.committed = snapshot(archive);
      for (const row of characters) {
        this.committed.characters.get(row.id)!.logs = row.logs.map(
          ({ sequence, time, text }) => ({ sequence, time, text }),
        );
      }
      return characters.length || plans.length || runs.length || requests.length
        ? archive
        : undefined;
    } catch {
      throw new AppError('无法读取 Agent 数据库记录。', 500);
    }
  }

  async save(archive: ManagementArchive): Promise<void> {
    const before = this.committed;
    try {
      const next = snapshot(archive, before);
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

          for (const [id, character] of next.characters) {
            await saveCharacter(tx, character, before.characters.get(id));
          }
          for (const row of next.plans.values()) {
            if (!changed(row, before.plans.get(row.id))) continue;
            await tx.agentPlan.upsert({
              where: { id: row.id },
              create: { id: row.id, position: row.position, data: json(row) },
              update: { position: row.position, data: json(row) },
            });
          }
          for (const [id, run] of next.runs) {
            await saveRun(tx, run, before.runs.get(id));
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
