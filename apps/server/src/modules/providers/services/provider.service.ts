import { AppError } from '../../../core/errors/app-error';
import { ModelCatalog } from '../adapters/model-catalog';
import { ProviderHealthChecker } from '../adapters/health-checker';
import type { ProviderRepository, ProviderRuntimePort } from '../ports';

export const PROVIDERS_CHANGED = 'providers.changed' as const;

export type ProviderChangedEvent = {
  type: typeof PROVIDERS_CHANGED;
  providerId: string;
};

export type ProviderEventPublisher = (event: ProviderChangedEvent) => void;

/** Coordinates provider writes and their cross-module reference rule. */
export class ProviderService {
  private readonly catalog: Pick<ModelCatalog, 'models'>;
  private readonly healthChecker: Pick<ProviderHealthChecker, 'check'>;

  constructor(
    private readonly store: Pick<
      ProviderRepository,
      'list' | 'save' | 'remove'
    >,
    catalog?: Pick<ModelCatalog, 'models'>,
    private readonly hasCharacterReference: (id: string) => boolean = () => false,
    private readonly changed: ProviderEventPublisher = () => {},
    healthChecker?: Pick<ProviderHealthChecker, 'check'>,
  ) {
    this.catalog = catalog ?? new ModelCatalog(store as unknown as ProviderRuntimePort);
    this.healthChecker =
      healthChecker ?? new ProviderHealthChecker(store as unknown as ProviderRuntimePort);
  }

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
