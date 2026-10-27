import { env } from '../../../core/config/env';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppError } from '../../../core/errors/app-error';
import { toProviderView, type SavedProvider } from '../domain/model';
import { validateProvider } from '../domain/validation';
import type { ProviderRepository } from './repository.port';

/** Atomic JSON implementation of the provider repository. */
export class FileProviderRepository implements ProviderRepository {
  private values: SavedProvider[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path = env.dataPath('agent-providers.json')) {}

  /**
   * Load saved providers from disk.
   * Returns true if loaded from existing file, false if file did not exist.
   */
  async load(): Promise<boolean> {
    try {
      const content = await readFile(this.path, 'utf8');
      const list = JSON.parse(content);
      if (!Array.isArray(list) || list.length > 20) {
        throw new AppError('模型服务配置格式错误。');
      }
      this.values = list.map((item) => validateProvider(item));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.values = [];
        return false;
      }
      throw new AppError('无法读取模型服务配置，请检查本地配置文件。', 500);
    }
  }

  /** Seed initial providers and persist them to disk. */
  async seed(initial: SavedProvider[]): Promise<void> {
    return this.mutate(async () => {
      this.values = initial.map((item) => validateProvider(item));
      await this.persist(this.values);
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

  private async persist(values: SavedProvider[]) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(values, null, 2), {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(fn);
    this.queue = operation.catch(() => {});
    return operation;
  }

  save(value: unknown, id?: string) {
    return this.mutate(async () => {
      if (!id && this.values.length >= 20)
        throw new AppError('最多保存 20 个模型服务。');
      const provider = validateProvider(
        value,
        id ? this.getRuntime(id) : undefined,
      );
      if (!id && this.values.some((p) => p.id === provider.id)) {
        throw new AppError('已存在相同 ID 的模型服务。', 409);
      }
      const next = id
        ? this.values.map((p) => (p.id === id ? provider : p))
        : [...this.values, provider];
      await this.persist(next);
      this.values = next;
      return toProviderView(provider);
    });
  }

  remove(id: string) {
    return this.mutate(async () => {
      this.getRuntime(id);
      const next = this.values.filter((p) => p.id !== id);
      await this.persist(next);
      this.values = next;
    });
  }
}
