import { isIP } from 'node:net';
import { AppError } from '../../../common/errors';
import { text } from '../../../common/validation';
import type { ProviderType } from '@voxel/shared';
import { PROVIDER_SPECS } from './specs';

/** Whether a literal address belongs to a supported local/private range. */
export function isPrivateOrLoopbackAddress(hostname: string): boolean {
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    return true;
  }

  const cleanHost = hostname.replace(/^\[|\]$/g, '');
  const ipVersion = isIP(cleanHost);

  if (ipVersion === 4) {
    const [first, second] = cleanHost.split('.').map(Number);
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  if (ipVersion === 6) {
    const firstGroup = parseInt(cleanHost.split(':')[0], 16);
    return (firstGroup & 0xfe00) === 0xfc00;
  }

  return false;
}

/** Validate and normalize a configured base URL before it can be used by adapters. */
export function validateProviderBaseUrl(
  type: ProviderType,
  rawUrl: unknown,
): { url: URL; baseUrl: string } {
  const spec = PROVIDER_SPECS[type];
  let url: URL;
  try {
    url = new URL(text(rawUrl, '接口地址', 500, spec.defaultUrl));
  } catch {
    throw new AppError('请输入有效的 API Base URL。');
  }

  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const isPrivateOrLoopback = isPrivateOrLoopbackAddress(url.hostname);
  const allowHttp = isLoopback || (type === 'ollama' && isPrivateOrLoopback);

  const hasInvalidComponents =
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowHttp));

  if (hasInvalidComponents) {
    throw new AppError(
      type === 'ollama'
        ? 'Ollama 接口须使用本机或局域网私有 IP 地址，且为 HTTP 或 HTTPS，不能包含密码、查询参数或锚点。'
        : '接口须为 HTTPS 或本机 HTTP 地址，不能包含密码、查询参数或锚点。',
    );
  }

  spec.validate?.(url, isPrivateOrLoopback);

  const baseUrl = spec.formatBaseUrl?.(url) ?? url.href.replace(/\/$/, '');
  return { url, baseUrl };
}
