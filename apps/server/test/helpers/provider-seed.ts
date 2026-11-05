import type { SavedProvider } from '../../src/modules/providers/domain/model';
import type { ProviderRepository } from '../../src/modules/providers';
import { DEFAULT_PROVIDERS } from '../../prisma/seed-data';

export function createDefaultProviders(): SavedProvider[] {
  return DEFAULT_PROVIDERS.map((provider) => ({ ...provider }));
}

/**
 * Bootstrap provider repository in test environments and fixtures:
 * loads existing configuration or seeds provider templates if absent.
 */
export async function bootstrapProviders(
  repository: ProviderRepository,
): Promise<void> {
  if ((await repository.list()).length > 0) {
    return;
  }
  if ('load' in repository && typeof repository.load === 'function')
    await repository.load();
  if ((await repository.list()).length === 0) {
    const defaults = createDefaultProviders();
    if (
      'seed' in repository &&
      typeof (repository as { seed: unknown }).seed === 'function'
    ) {
      await (
        repository as { seed: (items: SavedProvider[]) => Promise<void> }
      ).seed(defaults);
    } else {
      for (const provider of defaults) {
        await repository.save(provider);
      }
    }
  }
}
