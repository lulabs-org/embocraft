import type { ProviderView } from '@voxel/shared';
import type { SavedProvider } from './domain/model';

/** Trusted server components use this port when an upstream API key is required. */
export interface ProviderRuntimePort {
  getRuntime(id: string): SavedProvider | Promise<SavedProvider>;
}

export interface ProviderRepository extends ProviderRuntimePort {
  list(): ProviderView[] | Promise<ProviderView[]>;
  get(id: string): ProviderView | Promise<ProviderView>;
  save(value: unknown, id?: string): Promise<ProviderView>;
  remove(id: string): Promise<void>;
}

/** Low-level HTTP call to an upstream provider's `/models` endpoint. */
export type ProviderModelsClient = (
  provider: SavedProvider,
) => Promise<Response>;

/** Discovers the model IDs exposed by a saved provider. */
export interface ModelCatalogPort {
  models(id: string): Promise<string[]>;
}

export type ProviderHealth = {
  reachable: boolean;
  modelsAvailable: boolean;
};

/** Probes connectivity and model-list support of a saved provider. */
export interface ProviderHealthPort {
  check(id: string): Promise<ProviderHealth>;
}
