import { serverHttpUrl } from '../../network/endpoints';
import { getGatewayToken, reportUnknownOutcome } from '../../network/gateway';
import { managementRequest, UnknownOutcome } from '@voxel/shared/management';

export interface ConsoleFetchOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export async function consoleFetch<T>(
  path: string,
  options: ConsoleFetchOptions = {},
): Promise<T> {
  const { method = 'GET', body, signal, headers } = options;
  const normalizedPath = path ? (path.startsWith('/') ? path : `/${path}`) : '';
  const url = `${serverHttpUrl()}${normalizedPath}`;
  try {
    return await managementRequest<T>(url, {
      token: getGatewayToken(),
      method,
      body,
      signal,
      headers,
    });
  } catch (error) {
    if (error instanceof UnknownOutcome) reportUnknownOutcome(error);
    throw error;
  }
}
