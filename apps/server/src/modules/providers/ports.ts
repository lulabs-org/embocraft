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
