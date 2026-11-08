import type {
  ProviderHealth,
  ProviderHealthPort,
  ProviderModelsClient,
  ProviderRuntimePort,
} from '../ports';
import { assertApiKeyConfigured } from '../domain/validation';
import { fetchProviderModels } from './model-catalog';

export type { ProviderHealth } from '../ports';

/** Probe connectivity and whether the upstream exposes its model catalog. */
export class ProviderHealthChecker implements ProviderHealthPort {
  constructor(
    private readonly providers: ProviderRuntimePort,
    private readonly client: ProviderModelsClient = fetchProviderModels,
  ) {}

  async check(id: string): Promise<ProviderHealth> {
    const provider = await this.providers.getRuntime(id);
    assertApiKeyConfigured(provider);

    try {
      const response = await this.client(provider);
      await response.body?.cancel();
      return { reachable: true, modelsAvailable: response.ok };
    } catch {
      return { reachable: false, modelsAvailable: false };
    }
  }
}
