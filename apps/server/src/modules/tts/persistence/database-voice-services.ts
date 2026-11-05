import type { Prisma, PrismaClient } from '@prisma/client';
import { getDatabaseClient } from '../../../core/database/client';
import { decryptSecret, encryptSecret } from '../../../core/database/secrets';
import { AppError } from '../../../core/errors/app-error';
import type {
  SavedVoice,
  VoiceServicePersistence,
} from './voice-service-types';

function providerData(value: SavedVoice) {
  return {
    name: value.name,
    type: value.type,
    baseUrl: value.baseUrl,
    apiKey: encryptSecret(value.apiKey),
    model: value.model,
    voice: value.voice,
    speed: value.speed,
    voiceLanguage: value.voiceLanguage ?? null,
  };
}

function configuration(value: SavedVoice) {
  return JSON.stringify([
    value.name,
    value.type,
    value.baseUrl,
    value.apiKey,
    value.model,
    value.voice,
    value.speed,
    value.voiceLanguage ?? '',
  ]);
}

/** Persists TTS definitions; live bindings and synthesis stay in VoiceServiceStore. */
export class DatabaseVoiceServicePersistence
  implements VoiceServicePersistence
{
  private readonly db: PrismaClient;

  constructor(db?: PrismaClient) {
    this.db = db ?? getDatabaseClient();
  }

  private async read(
    db: Pick<Prisma.TransactionClient, 'ttsProvider'>,
  ): Promise<SavedVoice[]> {
    const rows = await db.ttsProvider.findMany({
      orderBy: { position: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type as SavedVoice['type'],
      baseUrl: row.baseUrl,
      apiKey: decryptSecret(row.apiKey),
      model: row.model,
      voice: row.voice,
      speed: row.speed,
      ...(row.voiceLanguage ? { voiceLanguage: row.voiceLanguage } : {}),
    }));
  }

  async load(): Promise<SavedVoice[]> {
    try {
      return await this.read(this.db);
    } catch {
      throw new AppError('无法读取语音服务数据库配置。', 500);
    }
  }

  private async write(
    tx: Prisma.TransactionClient,
    values: SavedVoice[],
  ): Promise<void> {
    const ids = new Set(values.map((value) => value.id));
    const existing = await tx.ttsProvider.findMany({
      select: { id: true },
    });
    for (const row of existing)
      if (!ids.has(row.id))
        await tx.ttsProvider.delete({ where: { id: row.id } });
    for (const [position, value] of values.entries()) {
      const payload = { position, ...providerData(value) };
      await tx.ttsProvider.upsert({
        where: { id: value.id },
        create: { id: value.id, ...payload },
        update: payload,
      });
    }
  }

  private async applyChanges(
    tx: Prisma.TransactionClient,
    previous: SavedVoice[],
    values: SavedVoice[],
  ) {
    const oldById = new Map(previous.map((value) => [value.id, value]));
    const nextIds = new Set(values.map((value) => value.id));
    for (const value of previous)
      if (!nextIds.has(value.id))
        await tx.ttsProvider.delete({ where: { id: value.id } });
    const newValues = values.filter((value) => !oldById.has(value.id));
    let position = newValues.length
      ? ((await tx.ttsProvider.aggregate({ _max: { position: true } }))._max
          .position ?? -1)
      : -1;
    for (const value of values) {
      const old = oldById.get(value.id);
      if (!old)
        await tx.ttsProvider.create({
          data: { id: value.id, position: ++position, ...providerData(value) },
        });
      else if (configuration(old) !== configuration(value))
        await tx.ttsProvider.update({
          where: { id: value.id },
          data: providerData(value),
        });
    }
  }

  private async transaction<T>(
    run: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('embocraft.tts.settings'))) AS held`;
        return run(tx);
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as { code?: string }).code === 'P2003')
        throw new AppError(
          '语音服务仍被 Agent 引用，请先更换或移除引用。',
          409,
        );
      throw new AppError('无法保存语音服务数据库配置。', 500);
    }
  }

  async update<T>(
    change: (values: SavedVoice[]) => {
      values: SavedVoice[];
      result: T;
    },
  ): Promise<T> {
    return this.transaction(async (tx) => {
      const previous = await this.read(tx);
      const { values, result } = change(previous);
      await this.applyChanges(tx, previous, values);
      return result;
    });
  }

  async save(values: SavedVoice[]): Promise<void> {
    await this.transaction((tx) => this.write(tx, values));
  }
}
