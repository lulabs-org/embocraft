import { AppError } from '../../../common/errors';
import type { ModelCatalog } from '../adapters/model-catalog';
import type { ProviderHealthChecker } from '../adapters/health-checker';
import type { ProviderRepository } from '../persistence/repository.port';
import { PROVIDERS_CHANGED, type ProviderEventPublisher } from './events';

/** Coordinates provider writes and their cross-module reference rule. */
export class ProviderService {
  constructor(
    private readonly store: Pick<
      ProviderRepository,
      'list' | 'save' | 'remove'
    >,
    private readonly catalog: Pick<ModelCatalog, 'models'>,
    private readonly hasCharacterReference: (id: string) => boolean,
    private readonly changed: ProviderEventPublisher,
    private readonly healthChecker: Pick<ProviderHealthChecker, 'check'>,
  ) {}

  list() {
    return this.store.list();
  }

  async save(value: unknown, id?: string) {
    const provider = await this.store.save(value, id);
    this.changed({ type: PROVIDERS_CHANGED, providerId: provider.id });
    return provider;
  }

  async remove(id: string) {
    if (this.hasCharacterReference(id))
      throw new AppError(
        '已有可复用 Agent 关联此模型服务，请保留配置或更新其密钥。',
        409,
      );
    await this.store.remove(id);
    this.changed({ type: PROVIDERS_CHANGED, providerId: id });
  }

  models(id: string) {
    return this.catalog.models(id);
  }

  health(id: string) {
    return this.healthChecker.check(id);
  }
}
