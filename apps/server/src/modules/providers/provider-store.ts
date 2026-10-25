import { env } from '../../config/env';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateProvider } from './provider-validation';
import { AppError } from '../../common/errors';
import { toProviderView, type SavedProvider } from './domain/model';

export { toProviderView } from './domain/model';

export class ProviderStore {
  private values: SavedProvider[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path = env.dataPath('agent-providers.json')) {}

  async load(envVars?: NodeJS.ProcessEnv) {
    let content: string;
    try {
      content = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AppError('无法读取模型服务配置，请检查本地配置文件。', 500);
      }
      const defaults = env.readProviders(envVars);
      this.values = [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          type: 'deepseek',
          apiKey: defaults.deepseekApiKey,
          defaultModel: defaults.deepseekModel,
        },
        {
          id: 'ollama',
          name: 'Ollama',
          type: 'ollama',
          defaultModel: defaults.ollamaModel,
        },
      ].map((p) => ({ ...validateProvider(p), id: p.id }));

      await this.persist(this.values);
      return;
    }

    try {
      const saved = JSON.parse(content);
      if (!Array.isArray(saved) || saved.length > 20) throw Error();
      this.values = saved.map((p: SavedProvider) => {
        if (typeof p?.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(p.id))
          throw Error();
        return { ...validateProvider(p), id: p.id };
      });
    } catch {
      throw new AppError('无法读取模型服务配置，请检查本地配置文件。', 500);
    }
  }

  list() {
    return this.values.map(toProviderView);
  }

  get(id: string) {
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
      const provider = validateProvider(value, id ? this.get(id) : undefined);
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
      this.get(id);
      const next = this.values.filter((p) => p.id !== id);
      await this.persist(next);
      this.values = next;
    });
  }
}
