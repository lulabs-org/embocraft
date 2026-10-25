import { AppError } from '../../../common/errors';
import type { ProviderQueryPort } from '../ports';
import { ProviderHttpClient } from './client';

export type ProviderHealth = {
  reachable: boolean;
  modelsAvailable: boolean;
};

/** Probe connectivity and whether the upstream exposes its model catalog. */
export class ProviderHealthChecker {
  constructor(
    private readonly providers: Pick<ProviderQueryPort, 'get'>,
    private readonly client = new ProviderHttpClient(),
  ) {}

  async check(id: string): Promise<ProviderHealth> {
    const provider = this.providers.get(id);
    if (provider.type !== 'ollama' && !provider.apiKey)
      throw new AppError('请先配置 API Key。');

    try {
      const response = await this.client.getModels(provider);
      await response.body?.cancel();
      return { reachable: true, modelsAvailable: response.ok };
    } catch {
      return { reachable: false, modelsAvailable: false };
    }
  }
}
