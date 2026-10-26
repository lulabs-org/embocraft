import type { ProviderType } from '@voxel/shared';

export interface ProviderSpec {
  defaultUrl: string;
  requiresApiKey: boolean;
}

/** Provider-specific defaults and configuration metadata. */
export const PROVIDER_SPECS: Record<ProviderType, ProviderSpec> = {
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
