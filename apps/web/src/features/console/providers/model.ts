import type { ProviderDraft, ProviderType } from '@voxel/shared';

export type { ProviderDraft };

export const presets = {
  gemini: {
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-flash-lite-latest',
  },
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

export const freshProvider = (
  type: ProviderType = 'compatible',
): ProviderDraft => ({
  ...presets[type],
  name: '',
  type,
  apiKey: '',
});
