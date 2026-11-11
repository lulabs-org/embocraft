import { domainEvents } from '../../../core/events/domain-events';
import { ModelCatalog } from '../adapters/model-catalog';
import { ProviderHealthChecker } from '../adapters/health-checker';
import { providerRepository } from '../persistence/database-repository';
import type {
  ModelCatalogPort,
  ProviderHealthPort,
  ProviderRepository,
} from '../ports';

/** Coordinates provider writes and their cross-module reference rule. */
export class ProviderService {
  private readonly catalog: ModelCatalogPort;
  private readonly healthChecker: ProviderHealthPort;

  constructor(
    private readonly store: Pick<
      ProviderRepository,
      'list' | 'save' | 'remove' | 'getRuntime'
    > = providerRepository,
    catalog?: ModelCatalogPort,
    healthChecker?: ProviderHealthPort,
  ) {
    this.catalog = catalog ?? new ModelCatalog(store);
    this.healthChecker = healthChecker ?? new ProviderHealthChecker(store);
  }

  list() {
    return this.store.list();
  }

  async save(value: unknown, id?: string) {
    const provider = await this.store.save(value, id);
    domainEvents.emit('provider.changed', { providerId: provider.id });
    return provider;
  }

  async remove(id: string) {
    await domainEvents.emitAsync('provider.removing', { providerId: id });
    await this.store.remove(id);
    domainEvents.emit('provider.changed', { providerId: id });
  }

  models(id: string) {
    return this.catalog.models(id);
  }

  health(id: string) {
    return this.healthChecker.check(id);
  }
}

export const providerService = new ProviderService();
