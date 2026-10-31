import type { ProviderDraft, ProviderType, ProviderView } from '@voxel/shared';

export interface ProviderSpec {
  defaultUrl: string;
  requiresApiKey: boolean;
}

/** Provider-specific defaults and configuration metadata. */
export const PROVIDER_SPECS: Record<ProviderType, ProviderSpec> = {
  gemini: {
    defaultUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresApiKey: true,
  },
  deepseek: {
    defaultUrl: 'https://api.deepseek.com',
    requiresApiKey: true,
  },
  ollama: {
    defaultUrl: 'http://127.0.0.1:11434/v1',
    requiresApiKey: false,
  },
  compatible: {
    defaultUrl: '',
    requiresApiKey: true,
  },
};

/** Persisted provider configuration; the API key must not be exposed in views. */
export type SavedProvider = ProviderDraft & {
  id: string;
};

/**
 * Strip the plaintext API key from a saved provider and return a public view
 * indicating only whether a key has been configured (`hasApiKey: boolean`).
 */
export function toProviderView({
  apiKey,
  ...view
}: SavedProvider): ProviderView {
  return { ...view, hasApiKey: !!apiKey };
}
