import type { SavedProvider } from '../domain/model';

/** Shared upstream HTTP policy for provider probes. */
export class ProviderHttpClient {
  getModels(provider: SavedProvider): Promise<Response> {
    return fetch(`${provider.baseUrl.replace(/\/+$/, '')}/models`, {
      headers:
        provider.type === 'gemini'
          ? { 'x-goog-api-key': provider.apiKey }
          : { Authorization: `Bearer ${provider.apiKey || 'ollama'}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  }
}
