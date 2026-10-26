import { AppError } from '../../../common/errors';
import type { ProviderType } from '@voxel/shared';

export interface ProviderSpec {
  defaultUrl: string;
  requiresApiKey: boolean;
  inference: {
    timeoutMs: number;
    supportsThinking: boolean;
  };
  validate?: (url: URL) => void;
  formatBaseUrl?: (url: URL) => string;
}

/** Provider-specific defaults and URL restrictions. */
export const PROVIDER_SPECS: Record<ProviderType, ProviderSpec> = {
  deepseek: {
    defaultUrl: 'https://api.deepseek.com',
    requiresApiKey: true,
    inference: {
      timeoutMs: 60000,
      supportsThinking: true,
    },
    validate: (url) => {
      if (url.origin !== 'https://api.deepseek.com') {
        throw new AppError(
          'DeepSeek 使用官方地址；第三方网关请选择 OpenAI 兼容服务。',
        );
      }
    },
    formatBaseUrl: () => 'https://api.deepseek.com',
  },
  ollama: {
    defaultUrl: 'http://127.0.0.1:11434/v1',
    requiresApiKey: false,
    inference: {
      timeoutMs: 120000,
      supportsThinking: false,
    },
  },
  compatible: {
    defaultUrl: '',
    requiresApiKey: true,
    inference: {
      timeoutMs: 60000,
      supportsThinking: false,
    },
  },
};
