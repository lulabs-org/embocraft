import { AppError } from '../../../core/errors/app-error';
import type { ProviderRuntimePort } from '../ports';
import { PROVIDER_SPECS } from '../domain/specs';
import { ProviderHttpClient } from './client';

/** Model discovery belongs to providers and does not require a character session. */
export class ModelCatalog {
  private probing = new Set<string>();

  constructor(
    private readonly providers: ProviderRuntimePort,
    private readonly client = new ProviderHttpClient(),
  ) {}

  async models(id: string) {
    if (this.probing.has(id))
      throw new AppError('正在连接此模型服务，请稍候。', 429);
    const provider = this.providers.getRuntime(id);

    if (PROVIDER_SPECS[provider.type].requiresApiKey && !provider.apiKey)
      throw new AppError('请先配置 API Key。');
    this.probing.add(id);

    try {
      const res = await this.client.getModels(provider);
      if (!res.ok) throw 0;
      const { data = [], models = [] } = (await res.json()) as {
        data?: { id?: unknown }[];
        models?: { name?: unknown; supportedGenerationMethods?: string[] }[];
      };
      const ids = (
        provider.type === 'gemini'
          ? models
              .filter((m) =>
                m.supportedGenerationMethods?.includes('generateContent'),
              )
              .map((m) =>
                typeof m.name === 'string'
                  ? m.name.replace(/^models\//, '')
                  : undefined,
              )
          : data.map((m) => m.id)
      ).filter((item): item is string => typeof item === 'string');
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
