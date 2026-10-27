import { type SavedProvider } from './domain/model';
import { validateProvider } from './domain/validation';
import type { ProviderRepository } from './persistence/repository.port';

/** Construct empty provider templates; credentials are configured in the console. */
export function createDefaultProviders(): SavedProvider[] {
  return [
    validateProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'deepseek',
      apiKey: '',
      defaultModel: 'deepseek-flash',
    }),
    validateProvider({
      id: 'ollama',
      name: 'Ollama',
      type: 'ollama',
      defaultModel: '',
    }),
  ];
}

/**
 * Bootstrap provider repository on startup:
 * loads existing configuration or seeds provider templates if absent.
 */
export async function bootstrapProviders(
  repository: ProviderRepository,
): Promise<void> {
  if (repository.list().length > 0) {
    return;
  }
  const loaded = await repository.load();
  if (!loaded) {
    const defaults = createDefaultProviders();
    await repository.seed(defaults);
  }
}
