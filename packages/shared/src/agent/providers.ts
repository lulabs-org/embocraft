export type ProviderType = 'deepseek' | 'ollama' | 'compatible';

export type ProviderView = {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  defaultModel: string;
  hasApiKey: boolean;
};
