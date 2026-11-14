import type { Prisma, PrismaClient } from '@prisma/client';
import { db as sharedDb } from '../../../core/database/client';
import { decryptSecret, encryptSecret } from '../../../core/database/secrets';
import { AppError } from '../../../core/errors/app-error';
import { toProviderView, type SavedProvider } from '../domain/model';
import { validateProvider } from '../domain/validation';
import type { ProviderRepository } from '../ports';

const MAX_PROVIDERS = 20;

type ProviderRow = {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
};

function fromRow(row: ProviderRow): SavedProvider {
  return validateProvider({ ...row, apiKey: decryptSecret(row.apiKey) });
}

/** Reads model-service configuration directly from PostgreSQL. */
export class DatabaseProviderRepository implements ProviderRepository {
  constructor(private readonly db: PrismaClient = sharedDb) {}

  async list() {
    try {
      const rows = await this.db.agentProvider.findMany({
        orderBy: { position: 'asc' },
      });
      if (rows.length > MAX_PROVIDERS)
        throw new AppError('模型服务配置格式错误。', 500);
      return rows.map((row) => toProviderView(fromRow(row)));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('无法读取模型服务数据库配置。', 500);
    }
  }

  async get(id: string) {
    return toProviderView(await this.getRuntime(id));
  }

  async getRuntime(id: string): Promise<SavedProvider> {
    try {
      const row = await this.db.agentProvider.findUnique({ where: { id } });
      if (!row) throw new AppError('模型服务不存在。', 404);
      return fromRow(row);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('无法读取模型服务数据库配置。', 500);
    }
  }

  async save(value: unknown, id?: string) {
    try {
      return await this.db.$transaction(
        async (tx: Prisma.TransactionClient) => {
          await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('embocraft.providers.settings'))) AS held`;
          const rows = await tx.agentProvider.findMany({
            orderBy: { position: 'asc' },
          });
          const row = id ? rows.find((item) => item.id === id) : undefined;
          const existing = row ? fromRow(row) : undefined;
          const raw =
            id && !existing && typeof value === 'object' && value !== null
              ? { ...(value as Record<string, unknown>), id }
              : value;
          const provider = validateProvider(raw, existing);
          if (!existing && rows.some((item) => item.id === provider.id))
            throw new AppError('已存在相同 ID 的模型服务。', 409);
          if (!existing && rows.length >= MAX_PROVIDERS)
            throw new AppError(`最多保存 ${MAX_PROVIDERS} 个模型服务。`);
          const { id: providerId, ...payload } = provider;
          const dbPayload = {
            ...payload,
            apiKey: encryptSecret(payload.apiKey),
          };
          const position = rows.reduce(
            (max, item) => Math.max(max, item.position + 1),
            0,
          );
          await tx.agentProvider.upsert({
            where: { id: providerId },
            create: { ...dbPayload, id: providerId, position },
            update: dbPayload,
          });
          return toProviderView(provider);
        },
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('无法保存模型服务数据库配置。', 500);
    }
  }

  async remove(id: string) {
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('embocraft.providers.settings'))) AS held`;
        const existing = await tx.agentProvider.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!existing) throw new AppError('模型服务不存在。', 404);
        await tx.agentProvider.delete({ where: { id } });
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as { code?: string }).code === 'P2003')
        throw new AppError(
          '已有可复用 Agent 关联此模型服务，请保留配置或更新其密钥。',
          409,
        );
      throw new AppError('无法从数据库删除模型服务。', 500);
    }
  }
}

export const providerRepository = new DatabaseProviderRepository();
