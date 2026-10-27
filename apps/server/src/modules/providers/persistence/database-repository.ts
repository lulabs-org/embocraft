import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../../core/errors/app-error';
import { toProviderView, type SavedProvider } from '../domain/model';
import { validateProvider } from '../domain/validation';
import type { ProviderRepository } from './repository.port';

/** Database-backed provider catalog with synchronous runtime reads. */
export class DatabaseProviderRepository implements ProviderRepository {
  private values: SavedProvider[] = [];
  private nextPosition = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: PrismaClient) {}

  async load(): Promise<boolean> {
    const [state, rows] = await Promise.all([
      this.db.agentProviderState.findUnique({ where: { id: 1 } }),
      this.db.agentProvider.findMany({ orderBy: { position: 'asc' } }),
    ]).catch(() => {
      throw new AppError('无法读取模型服务数据库配置。', 500);
    });
    if (rows.length > 20) throw new AppError('模型服务配置格式错误。', 500);
    this.values = rows.map((row) => validateProvider(row));
    this.nextPosition = rows.reduce(
      (next, row) => Math.max(next, row.position + 1),
      0,
    );
    return !!state || rows.length > 0;
  }

  async seed(initial: SavedProvider[]): Promise<void> {
    return this.mutate(async () => {
      const values = initial.map((item) => validateProvider(item));
      await this.db
        .$transaction(async (tx) => {
          await tx.agentProviderState.upsert({
            where: { id: 1 },
            create: { id: 1 },
            update: {},
          });
          for (const [position, value] of values.entries())
            await tx.agentProvider.create({ data: { ...value, position } });
        })
        .catch(() => {
          throw new AppError('无法初始化模型服务数据库配置。', 500);
        });
      this.values = values;
      this.nextPosition = values.length;
    });
  }

  list() {
    return this.values.map(toProviderView);
  }

  get(id: string) {
    return toProviderView(this.getRuntime(id));
  }

  getRuntime(id: string) {
    const provider = this.values.find((p) => p.id === id);
    if (!provider) throw new AppError('模型服务不存在。', 404);
    return { ...provider };
  }

  save(value: unknown, id?: string) {
    return this.mutate(async () => {
      if (!id && this.values.length >= 20)
        throw new AppError('最多保存 20 个模型服务。');
      const provider = validateProvider(
        value,
        id ? this.getRuntime(id) : undefined,
      );
      if (!id && this.values.some((p) => p.id === provider.id))
        throw new AppError('已存在相同 ID 的模型服务。', 409);
      if (id) {
        await this.db.agentProvider
          .update({
            where: { id },
            data: {
              name: provider.name,
              type: provider.type,
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
              defaultModel: provider.defaultModel,
            },
          })
          .catch(() => {
            throw new AppError('无法保存模型服务数据库配置。', 500);
          });
      } else {
        await this.db.agentProvider
          .create({ data: { ...provider, position: this.nextPosition } })
          .catch(() => {
            throw new AppError('无法保存模型服务数据库配置。', 500);
          });
        this.nextPosition++;
      }
      this.values = id
        ? this.values.map((p) => (p.id === id ? provider : p))
        : [...this.values, provider];
      return toProviderView(provider);
    });
  }

  remove(id: string) {
    return this.mutate(async () => {
      this.getRuntime(id);
      try {
        await this.db.agentProvider.delete({ where: { id } });
      } catch (error) {
        if ((error as { code?: string }).code === 'P2003')
          throw new AppError(
            '已有可复用 Agent 关联此模型服务，请保留配置或更新其密钥。',
            409,
          );
        // Prisma errors may include the database connection string.
        throw new AppError('无法删除模型服务配置。', 500);
      }
      this.values = this.values.filter((p) => p.id !== id);
    });
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(fn);
    this.queue = operation.catch(() => {});
    return operation;
  }
}
