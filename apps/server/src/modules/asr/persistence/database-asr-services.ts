import type { PrismaClient } from '@prisma/client';
import type {
  AsrUse,
  BailianAsrSettings,
  SenseVoiceLanguage,
} from '@voxel/shared';
import { getDatabaseClient } from '../../../core/database/client';
import { decryptSecret, encryptSecret } from '../../../core/database/secrets';
import { AppError } from '../../../core/errors/app-error';
import type { AsrServicePersistence, SavedService } from './asr-settings-store';

/** Persists ASR definitions; active recordings stay in AsrSettingsStore. */
export class DatabaseAsrServicePersistence implements AsrServicePersistence {
  private readonly db: PrismaClient;

  constructor(db?: PrismaClient) {
    this.db = db ?? getDatabaseClient();
  }

  async load(): Promise<SavedService[]> {
    try {
      const rows = await this.db.asrProvider.findMany({
        orderBy: { position: 'asc' },
        include: { assignments: { orderBy: { use: 'asc' } } },
      });
      return rows.map((row): SavedService => {
        const uses = row.assignments.length
          ? row.assignments.map((assignment) => assignment.use as AsrUse)
          : undefined;
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
        if (row.provider === 'sense-voice') {
          // No secret is decrypted for server-side engines, and rows written before
          // the language column existed keep working as Chinese profiles.
          return {
            id: row.id,
            name: row.name,
            provider: 'sense-voice',
            model: row.model,
            language: (row.language || 'zh') as SenseVoiceLanguage,
            ...(uses ? { uses } : {}),
          };
        }
        return {
          id: row.id,
          name: row.name,
          provider: 'bailian',
          model: (row.model ||
            'fun-asr-realtime') as BailianAsrSettings['model'],
          region: (row.region || 'beijing') as BailianAsrSettings['region'],
          workspaceId: row.workspaceId ?? '',
          apiKey: decryptSecret(row.apiKey),
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
          const base = { position, name: value.name, model: value.model };
          // Server-side engines keep no secret, so their rows never store one.
          const payload =
            value.provider === 'whisper'
              ? {
                  ...base,
                  provider: 'whisper',
                  apiKey: encryptSecret(value.apiKey ?? ''),
                  region: null,
                  workspaceId: null,
                  language: null,
                  baseUrl: value.baseUrl ?? '',
                  temperature: value.temperature ?? 0,
                  prompt: value.prompt,
                }
              : value.provider === 'sense-voice'
                ? {
                    ...base,
                    provider: 'sense-voice',
                    // Empty ciphertext keeps the NOT NULL column uniform; it is never read.
                    apiKey: encryptSecret(''),
                    region: null,
                    workspaceId: null,
                    language: value.language,
                    baseUrl: null,
                    temperature: null,
                    prompt: null,
                  }
                : {
                    ...base,
                    provider: 'bailian',
                    apiKey: encryptSecret(value.apiKey),
                    region: value.region,
                    workspaceId: value.workspaceId,
                    language: null,
                    baseUrl: null,
                    temperature: null,
                    prompt: null,
                  };
          await tx.asrProvider.upsert({
            where: { id: value.id },
            create: { id: value.id, ...payload },
            update: payload,
          });
        }
        const assignments = values.flatMap((value) =>
          (value.uses ?? []).map((use) => {
            if (use === 'clip' && value.provider !== 'whisper')
              throw new Error('Clip recognition requires Whisper.');
            return { use, providerId: value.id };
          }),
        );
        if (assignments.length)
          await tx.asrAssignment.createMany({ data: assignments });
      });
    } catch {
      throw new AppError('无法保存 ASR 数据库配置。', 500);
    }
  }
}
