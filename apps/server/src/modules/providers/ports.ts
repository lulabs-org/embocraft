import type { ProviderView } from '@voxel/shared';
import type { SavedProvider } from './domain/model';

/** Public provider reads never expose API keys. */
export interface ProviderQueryPort {
  list(): ProviderView[];
  get(id: string): ProviderView;
}

/** Trusted server components use this port when an upstream API key is required. */
export interface ProviderRuntimePort {
  getRuntime(id: string): SavedProvider;
}

/** Mutations available to provider management. */
export interface ProviderCommandPort {
  save(value: unknown, id?: string): Promise<ProviderView>;
  remove(id: string): Promise<void>;
}

export interface ProviderPort
  extends ProviderQueryPort,
    ProviderRuntimePort,
    ProviderCommandPort {}
