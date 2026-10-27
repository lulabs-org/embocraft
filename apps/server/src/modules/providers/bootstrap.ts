import { env, type EnvLookup } from '../../core/config/env';
import { type SavedProvider } from './domain/model';
import { validateProvider } from './domain/validation';
import type { ProviderRepository } from './persistence/repository.port';

/** Construct default providers from environment variables for initial seeding. */
export function createDefaultProviders(envVars?: EnvLookup): SavedProvider[] {
  const defaults = env.readProviders(envVars);
  return [
    validateProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'deepseek',
      apiKey: defaults.deepseekApiKey,
      defaultModel: defaults.deepseekModel,
    }),
    validateProvider({
      id: 'ollama',
      name: 'Ollama',
      type: 'ollama',
      defaultModel: defaults.ollamaModel,
    }),
  ];
}

/**
 * Bootstrap provider repository on startup:
 * loads existing configuration or seeds defaults from environment if absent.
 */
export async function bootstrapProviders(
  repository: ProviderRepository,
  envVars?: EnvLookup,
): Promise<void> {
  if (repository.list().length > 0) {
    return;
  }
  const loaded = await repository.load();
  if (!loaded) {
    const defaults = createDefaultProviders(envVars);
    await repository.seed(defaults);
  }
}
