import type { ProviderView } from '@voxel/shared';
import type { SavedProvider } from './domain/model';

export interface ProviderPort {
  list(): ProviderView[];
  get(id: string): SavedProvider;
  save(value: unknown, id?: string): Promise<ProviderView>;
  remove(id: string): Promise<void>;
}
