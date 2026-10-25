export type ProviderType = 'deepseek' | 'ollama' | 'compatible';

export type ProviderInference = {
  timeoutMs: number;
  maxTokens: number;
  thinking: 'enabled' | 'disabled';
  reasoningEffort: 'none' | 'low' | 'high' | 'max';
};

export type ProviderView = {
  /** Absent in legacy services until inference settings are saved. */
  inference?: ProviderInference;
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  defaultModel: string;
  hasApiKey: boolean;
};
