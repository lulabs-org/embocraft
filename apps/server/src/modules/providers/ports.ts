import type { ProviderView } from '@voxel/shared';
import type { SavedProvider } from './domain/model';

/** Read-only access for character scheduling and runtime configuration. */
export interface ProviderQueryPort {
  list(): ProviderView[];
  get(id: string): SavedProvider;
}

/** Mutations available to provider management. */
export interface ProviderCommandPort {
  save(value: unknown, id?: string): Promise<ProviderView>;
  remove(id: string): Promise<void>;
}

export interface ProviderPort extends ProviderQueryPort, ProviderCommandPort {}
