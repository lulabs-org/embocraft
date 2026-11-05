import type { Prisma, PrismaClient, TtsProvider } from '@prisma/client';
import { getDatabaseClient } from '../../../core/database/client';
import { decryptSecret, encryptSecret } from '../../../core/database/secrets';
import { AppError } from '../../../core/errors/app-error';
import type { SavedVoice } from '../domain/voice-service-validation';
import type {
  VoiceServicePersistence,
  VoiceServiceTransaction,
} from '../ports';

function fromRow(row: TtsProvider): SavedVoice {
  return {
    id: row.id,
    name: row.name,
    type: row.type as SavedVoice['type'],
    baseUrl: row.baseUrl,
    apiKey: decryptSecret(row.apiKey),
    model: row.model,
    voice: row.voice,
    speed: row.speed,
    ...(row.voiceLanguage ? { voiceLanguage: row.voiceLanguage } : {}),
  };
}

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

function repository(
  db: Pick<Prisma.TransactionClient, 'ttsProvider'>,
): VoiceServiceTransaction {
  return {
    async get(id) {
      const row = await db.ttsProvider.findUnique({ where: { id } });
      return row ? fromRow(row) : undefined;
    },
    count: () => db.ttsProvider.count(),
    async create(value) {
      const max = await db.ttsProvider.aggregate({ _max: { position: true } });
      await db.ttsProvider.create({
        data: {
          id: value.id,
          position: (max._max.position ?? -1) + 1,
          ...providerData(value),
        },
      });
    },
    async update(value) {
      await db.ttsProvider.update({
        where: { id: value.id },
        data: providerData(value),
      });
    },
    async remove(id) {
      await db.ttsProvider.delete({ where: { id } });
    },
  };
}

export class DatabaseVoiceServicePersistence
  implements VoiceServicePersistence
{
  constructor(private readonly customDb?: PrismaClient) {}

  private get db(): PrismaClient {
    return this.customDb ?? getDatabaseClient();
  }

  async load(): Promise<SavedVoice[]> {
    try {
      return (
        await this.db.ttsProvider.findMany({ orderBy: { position: 'asc' } })
      ).map(fromRow);
    } catch {
      throw new AppError('无法读取语音服务数据库配置。', 500);
    }
  }

  async get(id: string): Promise<SavedVoice | undefined> {
    try {
      return await repository(this.db).get(id);
    } catch {
      throw new AppError('无法读取语音服务数据库配置。', 500);
    }
  }

  async transaction<T>(
    run: (tx: VoiceServiceTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('embocraft.tts.settings'))) AS held`;
        return run(repository(tx));
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
}
