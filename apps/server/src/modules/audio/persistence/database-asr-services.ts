import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../../core/errors/app-error';
import type { AsrServicePersistence, SavedService } from './asr-settings-store';

/** Persists ASR definitions; active recordings stay in AsrSettingsStore. */
export class DatabaseAsrServicePersistence implements AsrServicePersistence {
  constructor(private readonly db: PrismaClient) {}

  async load(): Promise<SavedService[]> {
    try {
      const rows = await this.db.asrService.findMany({
        orderBy: { position: 'asc' },
      });
      return rows.map((row) => row.data as unknown as SavedService);
    } catch {
      throw new AppError('无法读取 ASR 数据库配置。', 500);
    }
  }

  async save(values: SavedService[]): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        const ids = new Set(values.map((value) => value.id));
        const existing = await tx.asrService.findMany({ select: { id: true } });
        for (const row of existing)
          if (!ids.has(row.id))
            await tx.asrService.delete({ where: { id: row.id } });
        for (const [position, value] of values.entries()) {
          const data = JSON.parse(
            JSON.stringify(value),
          ) as Prisma.InputJsonValue;
          await tx.asrService.upsert({
            where: { id: value.id },
            create: { id: value.id, position, data },
            update: { position, data },
          });
        }
      });
    } catch {
      throw new AppError('无法保存 ASR 数据库配置。', 500);
    }
  }
}
