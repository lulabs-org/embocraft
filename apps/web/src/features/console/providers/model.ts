import type { ProviderInference, ProviderType } from '@voxel/shared';
export const presets = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
  },
  ollama: {
    name: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: '',
  },
  compatible: { name: 'OpenAI 兼容服务', baseUrl: '', defaultModel: '' },
};
export const defaultInference: ProviderInference = {
  timeoutMs: 60000,
  maxTokens: 512,
  thinking: 'disabled',
  reasoningEffort: 'high',
};
export const freshProvider = (type: ProviderType = 'compatible') => ({
  ...presets[type],
  name: '',
  type,
  apiKey: '',
  inference: { ...defaultInference },
});
export type ProviderDraft = ReturnType<typeof freshProvider>;
