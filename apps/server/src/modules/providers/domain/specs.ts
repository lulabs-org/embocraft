import { AppError } from '../../../common/errors';
import type { ProviderType } from '@voxel/shared';

export interface ProviderSpec {
  defaultUrl: string;
  validate?: (url: URL, isPrivateOrLoopback: boolean) => void;
  formatBaseUrl?: (url: URL) => string;
}

/** Provider-specific defaults and URL restrictions. */
export const PROVIDER_SPECS: Record<ProviderType, ProviderSpec> = {
  deepseek: {
    defaultUrl: 'https://api.deepseek.com',
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
    validate: (_url, isPrivateOrLoopback) => {
      if (!isPrivateOrLoopback) {
        throw new AppError('Ollama 仅支持本机或局域网私有 IP 地址。');
      }
    },
  },
  compatible: { defaultUrl: '' },
};
