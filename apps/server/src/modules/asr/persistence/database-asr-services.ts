import type { PrismaClient } from '@prisma/client';
import type { AsrUse, BailianAsrSettings } from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import type { AsrServicePersistence, SavedService } from './asr-settings-store';

/** Persists ASR definitions; active recordings stay in AsrSettingsStore. */
export class DatabaseAsrServicePersistence implements AsrServicePersistence {
  constructor(private readonly db: PrismaClient) {}

  async load(): Promise<SavedService[]> {
    try {
      const rows = await this.db.asrProvider.findMany({
        orderBy: { position: 'asc' },
      });
      return rows.map((row): SavedService => {
        const uses = row.uses?.length ? (row.uses as AsrUse[]) : undefined;
        if (row.provider === 'whisper') {
          return {
            id: row.id,
            name: row.name,
            provider: 'whisper',
            model: row.model,
            baseUrl: row.baseUrl ?? '',
            temperature: row.temperature ?? 0,
            prompt: row.prompt ?? '',
            apiKey: row.apiKey,
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
          apiKey: row.apiKey,
          ...(uses ? { uses } : {}),
        };
      });
    } catch {
      throw new AppError('无法读取 ASR 数据库配置。', 500);
    }
  }

  async save(values: SavedService[]): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        const ids = new Set(values.map((value) => value.id));
        const existing = await tx.asrProvider.findMany({ select: { id: true } });
        for (const row of existing)
          if (!ids.has(row.id))
            await tx.asrProvider.delete({ where: { id: row.id } });
        for (const [position, value] of values.entries()) {
          const isWhisper = value.provider === 'whisper';
          const payload = {
            position,
            name: value.name,
            provider: isWhisper ? 'whisper' : 'bailian',
            model: value.model,
            apiKey: value.apiKey ?? '',
            uses: value.uses ?? [],
            region: !isWhisper ? value.region : null,
            workspaceId: !isWhisper ? value.workspaceId : null,
            baseUrl: isWhisper ? (value.baseUrl ?? '') : null,
            temperature: isWhisper ? (value.temperature ?? 0) : null,
            prompt: isWhisper ? (value.prompt ?? '') : null,
          };
          await tx.asrProvider.upsert({
            where: { id: value.id },
            create: { id: value.id, ...payload },
            update: payload,
          });
        }
      });
    } catch {
      throw new AppError('无法保存 ASR 数据库配置。', 500);
    }
  }
}
