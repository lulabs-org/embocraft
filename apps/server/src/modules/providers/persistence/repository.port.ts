import type { ProviderPort } from '../ports';
import type { SavedProvider } from '../domain/model';

/** Storage contract; loading is explicit so startup can await persistence. */
export interface ProviderRepository extends ProviderPort {
  /** Load saved providers from storage. Returns true if data was found, false if absent. */
  load(): Promise<boolean>;
  /** Seed initial providers and persist them to storage. */
  seed(initial: SavedProvider[]): Promise<void>;
}
