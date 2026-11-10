import type { Prisma, PrismaClient } from '@prisma/client';
import { getDatabaseClient } from '../core/database/client';
import { AppError } from '../core/errors/app-error';
import {
  applyManagementChange,
  type ArchivePort,
  type ManagementArchive,
  type ManagementChange,
} from './management-archive';
import {
  captureCharacter,
  restoreCharacter,
  saveCharacterConfiguration,
  saveCharacterState,
  type SavedCharacter,
} from '../modules/ai-characters/persistence';
import { stableJson } from '../core/database/stable-json';
import {
  captureRun,
  restoreRun,
  saveRun,
  type SavedRun,
} from '../modules/tasks/persistence';
import {
  capturePlan,
  restorePlan,
  savePlan,
  type SavedPlan,
} from '../modules/tasks/persistence';

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
  constructor(private readonly customDb?: PrismaClient) {}

  private get db(): PrismaClient {
    return this.customDb ?? getDatabaseClient();
  }

  async readSnapshot(): Promise<ManagementArchive | undefined> {
    return this.load();
  }

  private async read(tx: Prisma.TransactionClient) {
    const characters = await tx.agentCharacter.findMany({
      orderBy: { position: 'asc' },
      include: { state: true, logs: { orderBy: { sequence: 'asc' } } },
    });
    const plans = await tx.agentPlan.findMany({ orderBy: { position: 'asc' } });
    const runs = await tx.agentRun.findMany({
      orderBy: { position: 'asc' },
      include: { checkpoint: true },
    });
    const requests = await tx.agentRequest.findMany();
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
    const before = snapshot(archive);
    for (const row of characters) {
      before.characters.get(row.id)!.logs = row.logs.map(
        ({ sequence, time, text }) => ({ sequence, time, text }),
      );
    }
    return { archive, before };
  }

  async load(): Promise<ManagementArchive | undefined> {
    try {
      return await this.db.$transaction(
        async (tx) => {
          const { archive } = await this.read(tx);
          return archive.characters.length ||
            archive.plans.length ||
            archive.runs.length ||
            Object.keys(archive.requests).length
            ? archive
            : undefined;
        },
        { isolationLevel: 'RepeatableRead' },
      );
    } catch {
      throw new AppError('无法读取 Agent 数据库记录。', 500);
    }
  }

  async commit(change: ManagementChange): Promise<ManagementArchive> {
    return this.write((stored) => applyManagementChange(stored, change));
  }

  async save(archive: ManagementArchive): Promise<void> {
    await this.write(() => archive);
  }

  private async write(
    change: (stored: ManagementArchive) => ManagementArchive,
  ) {
    try {
      return await this.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('embocraft.characters.commit'))) AS held`;
          const { archive: stored, before } = await this.read(tx);
          const archive = change(stored);
          const next = snapshot(archive, before);
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
          return archive;
        },
        { maxWait: 10000, timeout: 30000 },
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('无法保存 Agent 数据库记录。', 500);
    }
  }
}
