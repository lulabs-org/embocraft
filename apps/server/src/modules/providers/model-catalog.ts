import { AppError } from '../../common/errors';
import type { ProviderPort } from './provider-port';
import type { SavedProvider } from './provider-validation';

export type ModelQuery = (provider: SavedProvider) => Promise<string[]>;

/** Model discovery belongs to providers and does not require a character session. */
export class ModelCatalog {
  private probing = new Set<string>();

  constructor(
    private providers: Pick<ProviderPort, 'get'>,
    private query?: ModelQuery,
  ) {}

  async models(id: string) {
    if (this.probing.has(id))
      throw new AppError('正在连接此模型服务，请稍候。', 429);
    const provider = this.providers.get(id);
    if (provider.type !== 'ollama' && !provider.apiKey)
      throw new AppError('请先配置 API Key。');
    this.probing.add(id);
    try {
      if (this.query) return await this.query(provider);
      const res = await fetch(
        `${provider.baseUrl.replace(/\/+$/, '')}/models`,
        {
          headers: { Authorization: `Bearer ${provider.apiKey || 'ollama'}` },
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!res.ok) throw 0;
      const { data = [] } = (await res.json()) as {
        data?: { id?: unknown }[];
      };
      const ids = data
        .map((m) => m.id)
        .filter((item): item is string => typeof item === 'string');
      return [...new Set(ids)].slice(0, 200).sort();
    } catch {
      throw new AppError(
        '无法获取模型列表，请检查地址、密钥和服务状态。支持的模型 ID 也可手动填写。',
        502,
      );
    } finally {
      this.probing.delete(id);
    }
  }
}
