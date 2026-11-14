import type { Prisma, PrismaClient } from '@prisma/client';
import { db as sharedDb } from '../core/database/client';
import { AppError } from '../core/errors/app-error';
import {
  applyManagementChange,
  type ManagementArchive,
  type ManagementChange,
} from './management-archive';
import {
  CharacterQueries,
  captureCharacter,
  restoreCharacter,
  saveCharacterConfiguration,
  saveCharacterState,
  type SavedCharacter,
} from '../modules/ai-characters/persistence';
import { stableJson } from '../core/database/stable-json';
import {
  TaskQueries,
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

import type { ManagementStore } from './management-store';

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
export class DatabaseManagementArchive implements ManagementStore {
  readonly characters: CharacterQueries;
  readonly tasks: TaskQueries;
  constructor(private readonly db: PrismaClient = sharedDb) {
    this.characters = new CharacterQueries(this.db);
    this.tasks = new TaskQueries(this.db);
  }

  private async read(tx: Prisma.TransactionClient, change?: ManagementChange) {
    const characters = await tx.agentCharacter.findMany({
      orderBy: { position: 'asc' },
      include: { state: true, logs: { orderBy: { sequence: 'asc' } } },
    });
    // A normal commit reads only changed tasks and the dependencies required to
    // validate selected character checkpoints. Full reads are reserved for load/save.
    const edits = change?.taskChanges;
    const runIds = edits
      ? [
          ...edits.runs.map((entry) => entry.id),
          ...characters.flatMap((row) =>
            row.state?.currentRunId ? [row.state.currentRunId] : [],
          ),
          ...(change?.characters.flatMap((row) =>
            row.currentRunId ? [row.currentRunId] : [],
          ) ?? []),
        ]
      : undefined;
    const runs = await tx.agentRun.findMany({
      ...(edits
        ? {
            where: {
              OR: [
                { id: { in: runIds! } },
                { characterId: { in: change?.remove ?? [] } },
              ],
            },
          }
        : {}),
      orderBy: { position: 'asc' },
      include: { checkpoint: true },
    });
    const requests = await tx.agentRequest.findMany({
      where: edits
        ? { key: { in: edits.requests.map((entry) => entry.id) } }
        : undefined,
    });
    const planIds = edits
      ? [
          ...edits.plans.map((entry) => entry.id),
          ...runs.flatMap((row) => (row.planId ? [row.planId] : [])),
          ...edits.runs.flatMap((entry) =>
            entry.after?.planId ? [entry.after.planId] : [],
          ),
          ...requests.map((row) => row.planId),
          ...edits.requests.flatMap((entry) =>
            entry.after ? [entry.after] : [],
          ),
        ]
      : undefined;
    const plans = await tx.agentPlan.findMany({
      ...(edits
        ? {
            where: {
              OR: [
                { id: { in: planIds! } },
                { characterId: { in: change?.remove ?? [] } },
              ],
            },
          }
        : {}),
      orderBy: { position: 'asc' },
    });
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
    // Scoped reads must retain the durable global ordering, including gaps.
    for (const row of plans) before.plans.get(row.id)!.position = row.position;
    for (const row of runs) before.runs.get(row.id)!.position = row.position;
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
    const saved = await this.write(
      (stored) => applyManagementChange(stored, change),
      change.taskChanges ? change : undefined,
    );
    // Keep the caller's submitted task baseline for subsequent deltas. Unrelated
    // database tasks were neither read nor acknowledged by this execution host.
    return change.taskChanges
      ? {
          version: 3,
          characters: saved.characters,
          plans: change.plans,
          runs: change.runs,
          requests: change.requests,
        }
      : saved;
  }

  async save(archive: ManagementArchive): Promise<void> {
    await this.write(() => archive);
  }

  private async write(
    change: (stored: ManagementArchive) => ManagementArchive,
    scope?: ManagementChange,
  ) {
    try {
      return await this.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('embocraft.characters.commit'))) AS held`;
          const { archive: stored, before } = await this.read(tx, scope);
          const archive = change(stored);
          if (
            scope?.remove?.length &&
            (archive.plans.some(
              (plan) =>
                plan.characterId && scope.remove!.includes(plan.characterId),
            ) ||
              archive.runs.some(
                (run) =>
                  run.characterId &&
                  scope.remove!.includes(run.characterId) &&
                  !['completed', 'cancelled', 'missed', 'skipped'].includes(
                    run.status,
                  ),
              ))
          )
            throw new AppError('角色的任务记录已改变，请重新加载后重试。', 409);
          const next = snapshot(archive, before);
          if (scope) {
            let planPosition = [...next.plans.keys()].some(
              (id) => !before.plans.has(id),
            )
              ? ((await tx.agentPlan.aggregate({ _max: { position: true } }))
                  ._max.position ?? -1)
              : -1;
            let runPosition = [...next.runs.keys()].some(
              (id) => !before.runs.has(id),
            )
              ? ((await tx.agentRun.aggregate({ _max: { position: true } }))
                  ._max.position ?? -1)
              : -1;
            for (const [id, plan] of next.plans)
              plan.position = before.plans.get(id)?.position ?? ++planPosition;
            for (const [id, run] of next.runs)
              run.position = before.runs.get(id)?.position ?? ++runPosition;
          }
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
