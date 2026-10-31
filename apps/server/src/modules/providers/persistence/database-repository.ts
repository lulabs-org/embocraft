import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../../core/errors/app-error';
import { toProviderView, type SavedProvider } from '../domain/model';
import { validateProvider } from '../domain/validation';
import type { ProviderRepository } from '../ports';

const MAX_PROVIDERS = 20;

/** Provider repository with synchronous in-memory runtime reads and database persistence. */
export class DatabaseProviderRepository implements ProviderRepository {
  private values: SavedProvider[] = [];
  private nextPosition = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: PrismaClient) {}

  async load(): Promise<void> {
    try {
      const rows = await this.db.agentProvider.findMany({
        orderBy: { position: 'asc' },
      });
      if (rows.length > MAX_PROVIDERS) {
        throw new AppError('模型服务配置格式错误。', 500);
      }
      this.values = rows.map((row) => validateProvider(row));
      this.nextPosition = rows.reduce(
        (max, row) => Math.max(max, row.position + 1),
        0,
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('无法读取模型服务数据库配置。', 500);
    }
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
      const existing = id ? this.getRuntime(id) : undefined;
      const provider = validateProvider(value, existing);
      if (
        !existing &&
        (this.values.length >= MAX_PROVIDERS || this.nextPosition >= MAX_PROVIDERS)
      ) {
        throw new AppError(`最多保存 ${MAX_PROVIDERS} 个模型服务。`);
      }

      const { id: _, ...payload } = provider;
      try {
        await this.db.agentProvider.upsert({
          where: { id: provider.id },
          create: {
            ...payload,
            id: provider.id,
            position: this.nextPosition++,
          },
          update: payload,
        });
      } catch {
        throw new AppError('无法保存模型服务数据库配置。', 500);
      }

      this.values = existing
        ? this.values.map((p) => (p.id === provider.id ? provider : p))
        : [...this.values, provider];

      return toProviderView(provider);
    });
  }

  remove(id: string) {
    return this.mutate(async () => {
      this.getRuntime(id);
      try {
        await this.db.agentProvider.delete({ where: { id } });
      } catch {
        throw new AppError('无法从数据库删除模型服务。', 500);
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

