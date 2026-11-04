import type { PrismaClient } from '@prisma/client';
import { decryptSecret, encryptSecret } from '../../../core/database/secrets';
import { AppError } from '../../../core/errors/app-error';
import type { LiveVoiceProvider } from '@voxel/shared';
import type {
  LiveVoiceRepository,
  SavedLiveVoice,
} from '../services/live-voice-store';

export class DatabaseLiveVoice implements LiveVoiceRepository {
  constructor(private readonly db: PrismaClient) {}
  async load(): Promise<SavedLiveVoice[]> {
    const rows = await this.db.liveVoiceProvider.findMany({
      orderBy: { position: 'asc' },
    });
    return rows.map(
      ({ position: _position, apiKey, provider, ...settings }) => ({
        ...settings,
        provider: provider as LiveVoiceProvider,
        apiKey: decryptSecret(apiKey),
      }),
    );
  }
  async save(values: SavedLiveVoice[]): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        const existing = await tx.liveVoiceProvider.findMany({
          select: { id: true },
        });
        const ids = new Set(values.map((item) => item.id));
        for (const row of existing)
          if (!ids.has(row.id))
            await tx.liveVoiceProvider.delete({ where: { id: row.id } });
        for (const [position, item] of values.entries()) {
          const { id, apiKey, ...settings } = item;
          const payload = {
            ...settings,
            position,
            apiKey: encryptSecret(apiKey),
          };
          await tx.liveVoiceProvider.upsert({
            where: { id },
            create: { id, ...payload },
            update: payload,
          });
        }
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2003')
        throw new AppError(
          '实时语音服务仍被 Agent 引用，请先更换或移除引用。',
          409,
        );
      throw new AppError('无法保存实时语音服务配置。', 500);
    }
  }
}
