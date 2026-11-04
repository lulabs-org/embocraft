import type { AddressInfo } from 'node:net';

/**
 * 将监听地址标准化为客户端可访问的 host：
 * - 将通配地址 '0.0.0.0' 和 '::' 转为本地回环 '127.0.0.1'
 * - IPv6 地址按 RFC 3986 添加方括号包裹（例如 [::1]）
 */
export function formatClientHost(host: string): string {
  const h = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
  return h.includes(':') ? `[${h}]` : h;
}

export type ServerUrls = {
  httpUrl: string;
  wsUrl: string;
};

/**
 * 基于服务监听的 socket 地址和配置的 host 生成 http 与 ws 访问地址
 */
export function resolveServerUrls(
  address: AddressInfo,
  configuredHost: string,
): ServerUrls {
  const host = formatClientHost(configuredHost);
  const port = address.port;
  return {
    httpUrl: `http://${host}:${port}`,
    wsUrl: `ws://${host}:${port}`,
  };
}

