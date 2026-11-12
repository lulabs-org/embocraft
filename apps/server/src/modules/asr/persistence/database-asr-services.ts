import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  AsrUse,
  BailianAsrSettings,
  SenseVoiceLanguage,
} from '@voxel/shared';
import { getDatabaseClient } from '../../../core/database/client';
import { decryptSecret, encryptSecret } from '../../../core/database/secrets';
import { AppError } from '../../../core/errors/app-error';
import type { SavedService } from '../domain';
import type { AsrRepositoryPort } from '../ports';

function providerData(value: SavedService) {
  const isWhisper = value.provider === 'whisper';
  // Whisper 与 SenseVoice 都连接外部 HTTP 服务，因此都需要保存地址与可选密钥。
  const isRemote = isWhisper || value.provider === 'sense-voice';
  const isBailian =
    value.provider === 'bailian' || value.provider === undefined;
  return {
    name: value.name,
    provider: value.provider ?? 'bailian',
    model: value.model,
    apiKey: encryptSecret(value.apiKey ?? ''),
    region: isBailian ? value.region : null,
    workspaceId: isBailian ? value.workspaceId : null,
    baseUrl: isRemote ? (value.baseUrl ?? '') : null,
    temperature: isWhisper ? (value.temperature ?? 0) : null,
    prompt: isWhisper ? (value.prompt ?? '') : null,
    language: value.provider === 'sense-voice' ? value.language : null,
  };
}

function configuration(value: SavedService) {
  const common = [
    value.name,
    value.provider ?? 'bailian',
    value.model,
    value.apiKey ?? '',
  ];
  if (value.provider === 'whisper')
    return JSON.stringify([
      ...common,
      value.baseUrl ?? '',
      value.temperature ?? 0,
      value.prompt ?? '',
    ]);
  if (value.provider === 'bailian' || value.provider === undefined)
    return JSON.stringify([...common, value.region, value.workspaceId ?? '']);
  if (value.provider === 'sense-voice')
    return JSON.stringify([...common, value.baseUrl ?? '', value.language]);
  return JSON.stringify(common);
}

/** Persists ASR definitions; active recordings stay in AsrService. */
export class DatabaseAsrServicePersistence implements AsrRepositoryPort {
  constructor(private readonly customDb?: PrismaClient) {}

  private get db(): PrismaClient {
    return this.customDb ?? getDatabaseClient();
  }

  private async read(
    db: Pick<Prisma.TransactionClient, 'asrProvider'>,
  ): Promise<SavedService[]> {
    const rows = await db.asrProvider.findMany({
      orderBy: { position: 'asc' },
      include: { assignments: { orderBy: { use: 'asc' } } },
    });
    return rows.map((row): SavedService => {
      const uses = row.assignments.length
        ? row.assignments.map((assignment) => assignment.use as AsrUse)
        : undefined;
      if (row.provider === 'openai' || row.provider === 'gemini') {
        return {
          id: row.id,
          name: row.name,
          provider: row.provider,
          model: row.model,
          apiKey: decryptSecret(row.apiKey),
          ...(uses ? { uses } : {}),
        };
      }
      if (row.provider === 'sense-voice') {
        // 外部服务与 Whisper 一样保存地址和可选密钥；历史记录默认使用中文。
        return {
          id: row.id,
          name: row.name,
          provider: 'sense-voice',
          model: row.model,
          baseUrl: row.baseUrl ?? '',
          language: (row.language || 'zh') as SenseVoiceLanguage,
          apiKey: decryptSecret(row.apiKey),
          ...(uses ? { uses } : {}),
        };
      }
      if (row.provider === 'whisper') {
        return {
          id: row.id,
          name: row.name,
          provider: 'whisper',
          model: row.model,
          baseUrl: row.baseUrl ?? '',
          temperature: row.temperature ?? 0,
          prompt: row.prompt ?? '',
          apiKey: decryptSecret(row.apiKey),
          ...(uses ? { uses } : {}),
        };
      }
      return {
        id: row.id,
        name: row.name,
        provider: 'bailian',
        model: (row.model || 'fun-asr-realtime') as BailianAsrSettings['model'],
        region: (row.region || 'beijing') as BailianAsrSettings['region'],
        workspaceId: row.workspaceId ?? '',
        apiKey: decryptSecret(row.apiKey),
        ...(uses ? { uses } : {}),
      };
    });
  }

  async load(): Promise<SavedService[]> {
    try {
      return await this.read(this.db);
    } catch {
      throw new AppError('无法读取 ASR 数据库配置。', 500);
    }
  }

  private async write(
    tx: Prisma.TransactionClient,
    values: SavedService[],
  ): Promise<void> {
    // Replace explicit selections atomically; missing selections keep domain fallbacks.
    await tx.asrAssignment.deleteMany();
    const ids = new Set(values.map((value) => value.id));
    const existing = await tx.asrProvider.findMany({
      select: { id: true },
    });
    for (const row of existing)
      if (!ids.has(row.id))
        await tx.asrProvider.delete({ where: { id: row.id } });
    for (const [position, value] of values.entries()) {
      const payload = { position, ...providerData(value) };
      await tx.asrProvider.upsert({
        where: { id: value.id },
        create: { id: value.id, ...payload },
        update: payload,
      });
    }
    const assignments = values.flatMap((value) =>
      (value.uses ?? []).map((use) => {
        // Whisper 与 SenseVoice 都走服务器音频接口，均支持语音消息转文字。
        if (
          use === 'clip' &&
          value.provider !== 'whisper' &&
          value.provider !== 'sense-voice'
        )
          throw new Error('Clip recognition requires Whisper or SenseVoice.');
        return { use, providerId: value.id };
      }),
    );
    if (assignments.length)
      await tx.asrAssignment.createMany({ data: assignments });
  }

  private async applyChanges(
    tx: Prisma.TransactionClient,
    previous: SavedService[],
    values: SavedService[],
  ) {
    const oldById = new Map(previous.map((value) => [value.id, value]));
    const nextById = new Map(values.map((value) => [value.id, value]));
    const assignments = (items: SavedService[]) =>
      new Map(
        items.flatMap((value) =>
          (value.uses ?? []).map((use) => [use, value.id] as const),
        ),
      );
    const before = assignments(previous);
    const after = assignments(values);
    const changedUses = [
      ...new Set([...before.keys(), ...after.keys()]),
    ].filter((use) => before.get(use) !== after.get(use));
    if (changedUses.length)
      await tx.asrAssignment.deleteMany({
        where: { use: { in: changedUses } },
      });
    for (const value of previous)
      if (!nextById.has(value.id))
        await tx.asrProvider.delete({ where: { id: value.id } });
    const newValues = values.filter((value) => !oldById.has(value.id));
    let position = newValues.length
      ? ((await tx.asrProvider.aggregate({ _max: { position: true } }))._max
          .position ?? -1)
      : -1;
    for (const value of values) {
      const old = oldById.get(value.id);
      if (!old)
        await tx.asrProvider.create({
          data: { id: value.id, position: ++position, ...providerData(value) },
        });
      else if (configuration(old) !== configuration(value))
        await tx.asrProvider.update({
          where: { id: value.id },
          data: providerData(value),
        });
    }
    const newAssignments = changedUses.flatMap((use) => {
      const providerId = after.get(use);
      return providerId ? [{ use, providerId }] : [];
    });
    if (newAssignments.length)
      await tx.asrAssignment.createMany({ data: newAssignments });
  }

  private async transaction<T>(
    run: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.$transaction(async (tx) => {
        // All application writers read after obtaining the same transaction-scoped lock.
        await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('embocraft.asr.settings'))) AS held`;
        return run(tx);
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('无法保存 ASR 数据库配置。', 500);
    }
  }

  async update<T>(
    change: (values: SavedService[]) => { values: SavedService[]; result: T },
  ): Promise<T> {
    return this.transaction(async (tx) => {
      const previous = await this.read(tx);
      const { values, result } = change(previous);
      await this.applyChanges(tx, previous, values);
      return result;
    });
  }

  async save(values: SavedService[]): Promise<void> {
    await this.transaction((tx) => this.write(tx, values));
  }
}
