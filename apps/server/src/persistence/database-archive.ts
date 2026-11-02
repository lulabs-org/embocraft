import type { PrismaClient } from '@prisma/client';
import { db as defaultDb } from '../core/database/client';
import { AppError } from '../core/errors/app-error';
import type { ArchivePort, ManagementArchive } from './archive';
import {
  captureCharacter,
  restoreCharacter,
  saveCharacterConfiguration,
  saveCharacterState,
  type SavedCharacter,
} from './character-storage';
import { stableJson } from './stable-json';
import { captureRun, restoreRun, saveRun, type SavedRun } from './run-storage';
import {
  capturePlan,
  restorePlan,
  savePlan,
  type SavedPlan,
} from './plan-storage';

type SavedSnapshot = {
  characters: Map<string, SavedCharacter>;
  plans: Map<string, SavedPlan>;
  runs: Map<string, SavedRun>;
  requests: Map<string, string>;
};

function snapshot(
  archive: ManagementArchive,
  previous?: SavedSnapshot,
): SavedSnapshot {
  const characters = new Set(
    archive.characters.map((character) => character.id),
  );
  const plans = new Set(archive.plans.map((plan) => plan.id));
  for (const plan of archive.plans)
    if (plan.characterId && !characters.has(plan.characterId))
      throw new Error('A plan must reference an existing character.');
  for (const run of archive.runs)
    if (run.planId && !plans.has(run.planId))
      throw new Error('A run must reference an existing plan.');
  if (previous) {
    for (const run of archive.runs) {
      if (
        run.characterId &&
        !characters.has(run.characterId) &&
        previous.runs.get(run.id)?.characterIdSnapshot !== run.characterId
      )
        throw new Error(
          'New run attribution must reference an existing character.',
        );
    }
    for (const [key, planId] of Object.entries(archive.requests)) {
      if (previous.requests.has(key) && previous.requests.get(key) !== planId)
        throw new Error(
          'An idempotency key cannot be reassigned to another plan.',
        );
    }
  }
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
    plans: new Map(
      archive.plans.map((plan, position) => [
        plan.id,
        capturePlan(plan, position),
      ]),
    ),
    runs: new Map(
      archive.runs.map((run, position) => [
        run.id,
        captureRun(run, position, characters),
      ]),
    ),
    requests: new Map(Object.entries(archive.requests)),
  };
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
  private readonly db: PrismaClient;

  constructor(db?: PrismaClient) {
    this.db = db ?? defaultDb;
  }

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
        plans: plans.map(restorePlan),
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
          // Release changing selections before deleting or replacing their targets.
          // This intermediate state is never visible outside the transaction.
          for (const [id, character] of before.characters) {
            if (
              character.state.currentRunId &&
              character.state.currentRunId !==
                next.characters.get(id)?.state.currentRunId
            )
              await tx.agentCharacterState.update({
                where: { characterId: id },
                data: { currentRunId: null },
              });
          }
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
            await saveCharacterConfiguration(
              tx,
              character,
              before.characters.get(id),
            );
          }
          for (const [id, plan] of next.plans) {
            await savePlan(tx, plan, before.plans.get(id));
          }
          for (const [id, run] of next.runs) {
            await saveRun(tx, run, before.runs.get(id));
          }
          for (const [id, character] of next.characters) {
            await saveCharacterState(tx, character, before.characters.get(id));
          }
          for (const [key, planId] of next.requests) {
            if (!next.plans.has(planId))
              throw new Error(
                'An idempotency request must reference an existing plan.',
              );
            if (before.requests.get(key) === planId) continue;
            await tx.agentRequest.create({ data: { key, planId } });
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

/** 默认的 Agent 持久化归档单例 */
export const defaultDatabaseArchive = new DatabaseManagementArchive();
