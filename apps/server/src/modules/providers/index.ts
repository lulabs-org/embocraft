import { DatabaseProviderRepository } from './persistence/database-repository';
import { ModelCatalog } from './adapters/model-catalog';
import { ProviderHealthChecker } from './adapters/health-checker';

export type { ProviderType } from '@voxel/shared';
export { ProviderHealthChecker } from './adapters/health-checker';
export { ModelCatalog } from './adapters/model-catalog';
export {
  resolveInferenceDefaults,
  validateInferenceSettings,
  validateProviderModel,
} from './domain/inference';
export type { InferenceSettings } from './domain/inference';
export { toProviderView, PROVIDER_SPECS } from './domain/model';
export type { SavedProvider } from './domain/model';
export { validateProvider } from './domain/validation';
export { DatabaseProviderRepository } from './persistence/database-repository';
export type { ProviderRepository, ProviderRuntimePort } from './ports';
export { installProviderRoutes } from './routes/providers.routes';
export {
  PROVIDERS_CHANGED,
  type ProviderChangedEvent,
  type ProviderEventPublisher,
  ProviderService,
} from './services/provider.service';

/** 默认的模型服务持久化仓储单例 */
export const defaultProviderRepository = new DatabaseProviderRepository();
/** 默认的模型目录单例 */
export const defaultModelCatalog = new ModelCatalog(defaultProviderRepository);
/** 默认的服务健康检查器单例 */
export const defaultProviderHealthChecker = new ProviderHealthChecker(
  defaultProviderRepository,
);
