import { AppError } from '../../../core/errors/app-error';
import type { ProviderRuntimePort } from '../ports';
import { PROVIDER_SPECS, type SavedProvider } from '../domain/model';
import { fetchProviderModels } from './model-catalog';

export type ProviderHealth = {
  reachable: boolean;
  modelsAvailable: boolean;
};

type FetchModels =
  | ((provider: SavedProvider) => Promise<Response>)
  | { getModels: (provider: SavedProvider) => Promise<Response> };

/** Probe connectivity and whether the upstream exposes its model catalog. */
export class ProviderHealthChecker {
  constructor(
    private readonly providers: ProviderRuntimePort,
    private readonly client: FetchModels = fetchProviderModels,
  ) {}

  async check(id: string): Promise<ProviderHealth> {
    const provider = this.providers.getRuntime(id);
    if (PROVIDER_SPECS[provider.type].requiresApiKey && !provider.apiKey)
      throw new AppError('请先配置 API Key。');

    try {
      const fetchFn =
        typeof this.client === 'function'
          ? this.client
          : this.client.getModels.bind(this.client);
      const response = await fetchFn(provider);
      await response.body?.cancel();
      return { reachable: true, modelsAvailable: response.ok };
    } catch {
      return { reachable: false, modelsAvailable: false };
    }
  }
}
