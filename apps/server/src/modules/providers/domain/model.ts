import type { ProviderDraft, ProviderView } from '@voxel/shared';

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
