import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../../core/errors/app-error';
import type {
  SavedVoice,
  VoiceServicePersistence,
} from './voice-service-store';

/** Persists TTS definitions; live bindings and synthesis stay in VoiceServiceStore. */
export class DatabaseVoiceServicePersistence
  implements VoiceServicePersistence
{
  constructor(private readonly db: PrismaClient) {}

  async load(): Promise<SavedVoice[] | undefined> {
    try {
      const [state, rows] = await Promise.all([
        this.db.ttsCatalogState.findUnique({ where: { id: 1 } }),
        this.db.ttsService.findMany({ orderBy: { position: 'asc' } }),
      ]);
      if (!state && rows.length === 0) return undefined;
      return rows.map((row) => row.data as unknown as SavedVoice);
    } catch {
      throw new AppError('无法读取语音服务数据库配置。', 500);
    }
  }

  async save(values: SavedVoice[]): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        await tx.ttsCatalogState.upsert({
          where: { id: 1 },
          create: { id: 1 },
          update: {},
        });
        const ids = new Set(values.map((value) => value.id));
        const existing = await tx.ttsService.findMany({ select: { id: true } });
        for (const row of existing)
          if (!ids.has(row.id))
            await tx.ttsService.delete({ where: { id: row.id } });
        for (const [position, value] of values.entries()) {
          const data = JSON.parse(
            JSON.stringify(value),
          ) as Prisma.InputJsonValue;
          await tx.ttsService.upsert({
            where: { id: value.id },
            create: { id: value.id, position, data },
            update: { position, data },
          });
        }
      });
    } catch {
      throw new AppError('无法保存语音服务数据库配置。', 500);
    }
  }
}
