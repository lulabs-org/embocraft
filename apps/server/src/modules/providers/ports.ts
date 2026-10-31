import type { ProviderView } from '@voxel/shared';
import type { SavedProvider } from './domain/model';

/** Trusted server components use this port when an upstream API key is required. */
export interface ProviderRuntimePort {
  getRuntime(id: string): SavedProvider;
}

export interface ProviderRepository extends ProviderRuntimePort {
  list(): ProviderView[];
  get(id: string): ProviderView;
  save(value: unknown, id?: string): Promise<ProviderView>;
  remove(id: string): Promise<void>;
  load(): Promise<void>;
}
