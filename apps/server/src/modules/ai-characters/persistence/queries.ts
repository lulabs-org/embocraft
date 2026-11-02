import type { Prisma, PrismaClient } from '@prisma/client';
import { db as defaultDb } from '../../../core/database/client';
import type { RuntimeState } from '@voxel/agent-runtime';
import type {
  AICharacterSettings,
  AICharacterSummary,
  TaskRun,
} from '@voxel/shared';
import type { TaskIdentity } from '@voxel/shared/management';
import { AppError } from '../../../core/errors/app-error';

export type CharacterDetail = AICharacterSummary & {
  taskIdentity: TaskIdentity | null;
};
export type CharacterQueryPort = Pick<
  CharacterQueries,
  'get' | 'list' | 'logs'
>;

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
    status: state.status as AICharacterSummary['status'],
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

/** HTTP reads go straight to PostgreSQL, independently of runtime recovery snapshots. */
export class CharacterQueries {
  private readonly db: PrismaClient;

  constructor(db?: PrismaClient) {
    this.db = db ?? defaultDb;
  }

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

/** 默认的 Agent 查询服务单例 */
export const defaultCharacterQueries = new CharacterQueries();
