import type { PrismaClient } from '@prisma/client';
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
      const rows = await this.db.ttsProvider.findMany({
        orderBy: { position: 'asc' },
      });
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type as SavedVoice['type'],
        baseUrl: row.baseUrl,
        apiKey: row.apiKey,
        model: row.model,
        voice: row.voice,
        speed: row.speed,
        ...(row.voiceLanguage ? { voiceLanguage: row.voiceLanguage } : {}),
      }));
    } catch {
      throw new AppError('无法读取语音服务数据库配置。', 500);
    }
  }

  async save(values: SavedVoice[]): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        const ids = new Set(values.map((value) => value.id));
        const existing = await tx.ttsProvider.findMany({ select: { id: true } });
        for (const row of existing)
          if (!ids.has(row.id))
            await tx.ttsProvider.delete({ where: { id: row.id } });
        for (const [position, value] of values.entries()) {
          const payload = {
            position,
            name: value.name,
            type: value.type,
            baseUrl: value.baseUrl,
            apiKey: value.apiKey,
            model: value.model,
            voice: value.voice,
            speed: value.speed,
            voiceLanguage: value.voiceLanguage ?? null,
          };
          await tx.ttsProvider.upsert({
            where: { id: value.id },
            create: { id: value.id, ...payload },
            update: payload,
          });
        }
      });
    } catch {
      throw new AppError('无法保存语音服务数据库配置。', 500);
    }
  }
}
