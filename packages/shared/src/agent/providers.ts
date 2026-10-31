/** Supported LLM service provider types. */
export type ProviderType = 'deepseek' | 'ollama' | 'compatible' | 'gemini';

/** Base provider configuration attributes common to both drafts and views. */
export type ProviderSettings = {
  /** Human-readable display name for the provider. */
  name: string;
  /** Service type / protocol family. */
  type: ProviderType;
  /** API base endpoint URL (e.g. https://api.deepseek.com or http://127.0.0.1:11434/v1). */
  baseUrl: string;
  /** Default model identifier used when characters do not specify an override. */
  defaultModel: string;
};

/** Client submission payload for creating or updating a provider, carrying sensitive credentials. */
export type ProviderDraft = ProviderSettings & {
  apiKey: string;
};

/** Public redacted view of a configured provider; the API key is masked as a boolean flag. */
export type ProviderView = ProviderSettings & {
  /** Unique provider identifier assigned by the server. */
  id: string;
  /** Whether a non-empty API key is configured on the server. */
  hasApiKey: boolean;
};
