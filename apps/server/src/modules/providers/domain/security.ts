import { AppError } from '../../../common/errors';
import { text } from '../../../common/validation';
import type { ProviderType } from '@voxel/shared';
import { PROVIDER_SPECS } from './specs';

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
  const allowHttp = type === 'ollama' || isLoopback;

  const hasInvalidComponents =
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowHttp));

  if (hasInvalidComponents) {
    throw new AppError(
      type === 'ollama'
        ? 'Ollama 接口须使用 HTTP 或 HTTPS，不能包含密码、查询参数或锚点。'
        : '接口须为 HTTPS 或本机 HTTP 地址，不能包含密码、查询参数或锚点。',
    );
  }

  spec.validate?.(url);

  const baseUrl = spec.formatBaseUrl?.(url) ?? url.href.replace(/\/$/, '');
  return { url, baseUrl };
}
