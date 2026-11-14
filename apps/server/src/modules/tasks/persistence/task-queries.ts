import type { Prisma, PrismaClient } from '@prisma/client';
import type { RuntimeState } from '@voxel/agent-runtime';
import type { TaskPlanSummary } from '@voxel/shared';
import { db as sharedDb } from '../../../core/database/client';
import { AppError } from '../../../core/errors/app-error';
import type {
  TaskPlanResult,
  TaskQueryPort,
  TaskRunPageResult,
} from '../ports';
import type { PlanQueryFilter } from '../domain/types';
import { runView } from '../domain/model';
import { restorePlan } from './plan-storage';
import { restoreRun } from './run-storage';

const characterSelect = {
  name: true,
  state: {
    select: {
      standby: true,
      currentCheckpoint: { select: { execution: true } },
    },
  },
} satisfies Prisma.AgentCharacterSelect;

type Character = Prisma.AgentCharacterGetPayload<{
  select: typeof characterSelect;
}> | null;
function identity(character: Character) {
  const execution = (character?.state?.currentCheckpoint?.execution ??
    character?.state?.standby) as RuntimeState['execution'] | null | undefined;
  return execution?.task.identity ?? null;
}

const planInclude = {
  character: { select: characterSelect },
  runs: {
    where: { source: { not: 'chat' } },
    orderBy: { position: 'desc' },
    take: 1,
    include: { checkpoint: true },
  },
} satisfies Prisma.AgentPlanInclude;

function planResult(
  row: Prisma.AgentPlanGetPayload<{ include: typeof planInclude }>,
): TaskPlanResult {
  const { character, runs, ...plan } = row;
  const latestRun = runs[0] ? runView(restoreRun(runs[0])) : undefined;
  return {
    value: {
      ...restorePlan(plan),
      latestRun: latestRun
        ? { ...latestRun, logs: [], actions: undefined }
        : undefined,
    },
    characterName: character?.name ?? undefined,
    taskIdentity: identity(character),
  };
}

const runInclude = {
  checkpoint: true,
  character: { select: characterSelect },
} satisfies Prisma.AgentRunInclude;
function runResult(
  row: Prisma.AgentRunGetPayload<{ include: typeof runInclude }>,
) {
  const { character, ...run } = row;
  return { value: runView(restoreRun(run)), taskIdentity: identity(character) };
}

/** Select only the requested plans/runs; filtering, ordering and page boundaries live in SQL. */
export class TaskQueries implements TaskQueryPort {
  constructor(private readonly db: PrismaClient = sharedDb) {}

  private async assertCharacter(tx: Prisma.TransactionClient, id: string) {
    if (
      !(await tx.agentCharacter.findUnique({
        where: { id },
        select: { id: true },
      }))
    )
      throw new AppError('Agent 不存在。', 404);
  }

  async plans(characterId?: string, requireCharacter = false) {
    return this.db.$transaction(
      async (tx) => {
        if (requireCharacter) await this.assertCharacter(tx, characterId!);
        const rows = await tx.agentPlan.findMany({
          where: characterId ? { characterId } : {},
          orderBy: { position: 'asc' },
          include: planInclude,
        });
        return rows.map(planResult);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async plan(id: string) {
    return this.db.$transaction(
      async (tx) => {
        const row = await tx.agentPlan.findUnique({
          where: { id },
          include: planInclude,
        });
        if (!row) throw new AppError('计划不存在。', 404);
        return planResult(row);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async planPage(filter: PlanQueryFilter) {
    // Prisma contains uses LIKE; escape metacharacters to preserve literal substring searches.
    const search = filter.search?.replace(/[\\%_]/g, '\\$&');
    const where: Prisma.AgentPlanWhereInput = {
      ...(filter.characterId ? { characterId: filter.characterId } : {}),
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      ...(filter.state === 'unassigned'
        ? { characterId: null, state: 'paused' }
        : { state: filter.state ?? { not: 'archived' } }),
      ...(filter.timing ? { scheduleKind: filter.timing } : {}),
    };
    // A character filter and unassigned are mutually exclusive, matching the old predicate.
    if (filter.characterId && filter.state === 'unassigned')
      where.AND = [{ characterId: filter.characterId }];
    const offset = filter.offset ?? 0;
    return this.db.$transaction(
      async (tx) => {
        const total = await tx.agentPlan.count({ where });
        const rows =
          offset < total
            ? await tx.agentPlan.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                skip: offset,
                take: 20,
                select: {
                  id: true,
                  name: true,
                  scheduleKind: true,
                  scheduleSpec: true,
                  timeZone: true,
                  state: true,
                  characterId: true,
                  characterName: true,
                  character: { select: { name: true } },
                },
              })
            : [];
        const items: TaskPlanSummary[] = rows.map((row) => ({
          id: row.id,
          name: row.name,
          timing: {
            ...(row.scheduleSpec as object),
            kind: row.scheduleKind,
          } as TaskPlanSummary['timing'],
          timeZone: row.timeZone,
          state: row.state as TaskPlanSummary['state'],
          characterId: row.characterId ?? undefined,
          characterName: row.character?.name ?? row.characterName ?? undefined,
        }));
        return {
          items,
          total,
          nextOffset: offset + 20 < total ? offset + 20 : undefined,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async runs(
    planId: string,
    offset = 0,
    characterId?: string,
    requireCharacter = false,
  ): Promise<TaskRunPageResult> {
    return this.db.$transaction(
      async (tx) => {
        if (requireCharacter) await this.assertCharacter(tx, characterId!);
        const plan = await tx.agentPlan.findUnique({
          where: { id: planId },
          select: { characterId: true },
        });
        if (!plan) throw new AppError('计划不存在。', 404);
        if (characterId && plan.characterId !== characterId)
          throw new AppError('计划执行角色已改变，请刷新后重试。', 409);
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new AppError('分页参数无效。');
        const where: Prisma.AgentRunWhereInput = {
          planId,
          source: { not: 'chat' },
        };
        const total = await tx.agentRun.count({ where });
        const items =
          offset < total
            ? await tx.agentRun.findMany({
                where,
                orderBy: { position: 'desc' },
                skip: offset,
                take: 20,
                include: runInclude,
              })
            : [];
        // The API returns all unfinished runs independently of the history page.
        const active = await tx.agentRun.findMany({
          where: {
            ...where,
            status: { notIn: ['completed', 'cancelled', 'missed', 'skipped'] },
          },
          orderBy: { position: 'desc' },
          include: runInclude,
        });
        return {
          items: items.map(runResult),
          active: active.map(runResult),
          total,
          nextOffset: offset + 20 < total ? offset + 20 : undefined,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
