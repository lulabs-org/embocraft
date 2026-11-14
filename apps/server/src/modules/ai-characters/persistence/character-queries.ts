import type { Prisma, PrismaClient } from '@prisma/client';
import { db as sharedDb } from '../../../core/database/client';
import type { RuntimeState } from '@voxel/agent-runtime';
import {
  AI_CHARACTER_LOG_LIMIT,
  type AICharacterSettings,
  type AICharacterView,
  type TaskRun,
} from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';

import type {
  CharacterDetail,
  CharacterQueryPort,
  CharacterReadPort,
} from '../ports';

import { restoreCharacter } from './character-storage';

const include = {
  provider: { select: { name: true } },
  voiceService: { select: { name: true } },
  state: {
    include: {
      currentRun: { select: { id: true, source: true, snapshot: true } },
      currentCheckpoint: true,
    },
  },
  runs: {
    where: { status: 'queued' },
    orderBy: [{ scheduledAt: 'asc' }, { position: 'asc' }],
    select: {
      id: true,
      snapshot: true,
      scheduledAt: true,
      coalescedTriggers: true,
    },
  },
} satisfies Prisma.AgentCharacterInclude;

type CharacterRow = Prisma.AgentCharacterGetPayload<{
  include: typeof include;
}>;

/** Database values only. Connection IDs and event versions are added by HTTP. */
function detail(row: CharacterRow): CharacterDetail {
  const {
    state,
    provider,
    voiceService,
    runs,
    position: _position,
    createdAt,
    updatedAt: _updatedAt,
    deletedAt: _deletedAt,
    ...config
  } = row;
  if (!state) throw new AppError('角色状态记录缺失。', 500);
  const execution = (state.currentCheckpoint?.execution ?? state.standby) as
    | RuntimeState['execution']
    | null;
  const memory = state.memory as RuntimeState['character'] | null;
  const current = state.currentRun;
  const action = execution?.effects.activeAction;
  // Startup normalizes legacy settings before serving requests. SQL NULL represents
  // an omitted optional setting, except the existing empty voice-service ID.
  const settings = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== null),
  ) as AICharacterSettings;
  return {
    ...settings,
    id: row.id,
    providerName: provider.name,
    voiceServiceId: row.voiceServiceId ?? '',
    voiceServiceName: voiceService?.name,
    createdAt: createdAt?.getTime() ?? 0,
    status: state.status as CharacterDetail['status'],
    task: execution?.task.current,
    taskIdentity: execution?.task.identity ?? null,
    taskExecution: current
      ? {
          runId: current.id,
          limits: (current.snapshot as TaskRun['snapshot']).limits,
          source: current.source,
          action: action
            ? { id: action.id, name: action.name, status: action.status }
            : undefined,
        }
      : undefined,
    ...(runs.length
      ? {
          queuedTasks: runs.map((run) => ({
            id: run.id,
            goal: (run.snapshot as TaskRun['snapshot']).goal,
            scheduledAt: run.scheduledAt.getTime(),
            coalescedTriggers: run.coalescedTriggers ?? 0,
          })),
        }
      : {}),
    usage: memory?.usage,
    lastResponse: execution?.health.lastResponse,
    taskRequiresReassignment: !!execution?.conversation.audienceExpired,
  };
}

const viewInclude = {
  ...include,
  runs: { ...include.runs, orderBy: { position: 'asc' as const } },
  logs: {
    orderBy: { sequence: 'desc' as const },
    take: AI_CHARACTER_LOG_LIMIT,
    select: { time: true, text: true },
  },
} satisfies Prisma.AgentCharacterInclude;

function internalView(
  row: Prisma.AgentCharacterGetPayload<{ include: typeof viewInclude }>,
): AICharacterView {
  const { logs, ...base } = row;
  const { taskIdentity: _identity, ...view } = detail(base);
  return {
    ...view,
    taskRequiresReassignment:
      row.state?.runtimeVersion == null
        ? undefined
        : view.taskRequiresReassignment,
    queuedTasks: view.queuedTasks ?? [],
    logEntries: logs.slice().reverse(),
  };
}

/** Targeted management and HTTP reads, independent of the full recovery archive. */
export class CharacterQueries implements CharacterQueryPort, CharacterReadPort {
  constructor(private readonly db: PrismaClient = sharedDb) {}

  async get(id: string): Promise<CharacterDetail> {
    const row = await this.db.$transaction(
      (tx) => tx.agentCharacter.findUnique({ where: { id }, include }),
      { isolationLevel: 'RepeatableRead' },
    );
    if (!row) throw new AppError('AI 角色 不存在。', 404);
    return detail(row);
  }

  async list(): Promise<CharacterDetail[]> {
    const rows = await this.db.$transaction(
      (tx) =>
        tx.agentCharacter.findMany({ orderBy: { position: 'desc' }, include }),
      { isolationLevel: 'RepeatableRead' },
    );
    return rows.map(detail);
  }

  async record(id: string) {
    return this.db.$transaction(
      async (tx) => {
        const row = await tx.agentCharacter.findUnique({
          where: { id },
          include: {
            state: {
              include: {
                currentRun: {
                  select: {
                    id: true,
                    characterId: true,
                    characterIdSnapshot: true,
                    checkpoint: true,
                  },
                },
              },
            },
            logs: {
              orderBy: { sequence: 'desc' },
              take: AI_CHARACTER_LOG_LIMIT,
            },
          },
        });
        if (!row) throw new AppError('Agent 不存在。', 404);
        const run = row.state?.currentRun;
        if (run?.checkpoint && run.checkpoint.version !== 4)
          throw new Error('Unsupported execution checkpoint.');
        const selected = run
          ? {
              characterId:
                run.characterIdSnapshot ?? run.characterId ?? undefined,
              runtime: run.checkpoint
                ? {
                    execution: run.checkpoint
                      .execution as unknown as RuntimeState['execution'],
                  }
                : undefined,
            }
          : undefined;
        return restoreCharacter(
          { ...row, logs: row.logs.reverse() },
          new Map(run && selected ? [[run.id, selected]] : []),
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async view(id: string): Promise<AICharacterView> {
    return this.db.$transaction(
      async (tx) => {
        const row = await tx.agentCharacter.findUnique({
          where: { id },
          include: viewInclude,
        });
        if (!row) throw new AppError('Agent 不存在。', 404);
        return internalView(row);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async views(): Promise<AICharacterView[]> {
    return this.db.$transaction(
      async (tx) => {
        const rows = await tx.agentCharacter.findMany({
          orderBy: { position: 'desc' },
          include: viewInclude,
        });
        return rows.map(internalView);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async hasProviderReference(id: string) {
    return !!(await this.db.agentCharacter.findFirst({
      where: { providerId: id },
      select: { id: true },
    }));
  }

  async hasVoiceServiceReference(id: string) {
    return !!(await this.db.agentCharacter.findFirst({
      where: { voiceServiceId: id },
      select: { id: true },
    }));
  }

  async logs(id: string, limit: number, offset: number) {
    return this.db.$transaction(
      async (tx) => {
        const character = await tx.agentCharacter.findUnique({
          where: { id },
          select: { _count: { select: { logs: true } } },
        });
        if (!character) throw new AppError('AI 角色 不存在。', 404);
        const total = character._count.logs;
        // Out-of-range cursors return an empty page, even beyond SQL integer limits.
        const entries =
          offset < total
            ? await tx.agentCharacterLog.findMany({
                where: { characterId: id },
                select: { time: true, text: true },
                orderBy: { sequence: 'desc' },
                skip: offset,
                take: limit,
              })
            : [];
        return { entries, total };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}

export const characterQueries = new CharacterQueries();
