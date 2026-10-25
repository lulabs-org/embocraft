import { AppError } from '../../common/errors';
import type { ModelCatalog } from './model-catalog';
import type { ProviderPort } from './provider-port';

/** Coordinates provider writes and their cross-module reference rule. */
export class ProviderService {
  constructor(
    private readonly store: Pick<ProviderPort, 'list' | 'save' | 'remove'>,
    private readonly catalog: Pick<ModelCatalog, 'models'>,
    private readonly hasCharacterReference: (id: string) => boolean,
    private readonly changed: () => void,
  ) {}

  list() {
    return this.store.list();
  }

  async save(value: unknown, id?: string) {
    const provider = await this.store.save(value, id);
    this.changed();
    return provider;
  }

  async remove(id: string) {
    if (this.hasCharacterReference(id))
      throw new AppError(
        '已有可复用 Agent 关联此模型服务，请保留配置或更新其密钥。',
        409,
      );
    await this.store.remove(id);
    this.changed();
  }

  models(id: string) {
    return this.catalog.models(id);
  }
}
