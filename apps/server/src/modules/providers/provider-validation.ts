import { AppError } from '../../common/errors';
import { object, text } from '../../common/validation';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { type ProviderView } from '@voxel/shared';

export type SavedProvider = Omit<ProviderView, 'hasApiKey'> & {
  apiKey: string;
};

type ProviderType = ProviderView['type'];

// ---------------------------------------------------------------------------
// 1. Provider 规格与类型策略配置
// ---------------------------------------------------------------------------

interface ProviderSpec {
  defaultUrl: string;
  validate?: (url: URL, isPrivateOrLoopback: boolean) => void;
  formatBaseUrl?: (url: URL) => string;
}

const PROVIDER_SPECS: Record<ProviderType, ProviderSpec> = {
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
  compatible: {
    defaultUrl: '',
  },
};

// ---------------------------------------------------------------------------
// 2. 底层网络安全校验（SSRF 防御）
// ---------------------------------------------------------------------------

/**
 * 判定主机名是否为环回地址（localhost）或 RFC 1918 / RFC 4193 局域网私有 IP
 */
function isPrivateOrLoopbackAddress(hostname: string): boolean {
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

/**
 * 校验 URL 的协议、路径和组件安全，阻止非法协议注入、凭据泄露及非法外联
 */
function validateProviderBaseUrl(
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

// ---------------------------------------------------------------------------
// 3. 字段级校验与变更合并
// ---------------------------------------------------------------------------

function assertProviderType(type: unknown): asserts type is ProviderType {
  if (type !== 'deepseek' && type !== 'ollama' && type !== 'compatible') {
    throw new AppError('不支持此服务类型。');
  }
}

function resolveApiKey(
  inputApiKey: unknown,
  previous: SavedProvider | undefined,
  currentUrl: URL,
  currentType: ProviderType,
): string {
  const apiKey = text(inputApiKey, 'API Key', 4096);
  if (
    previous?.apiKey &&
    !apiKey &&
    (new URL(previous.baseUrl).origin !== currentUrl.origin ||
      previous.type !== currentType)
  ) {
    throw new AppError('更换服务地址或类型时，请重新填写 API Key。');
  }
  return apiKey || previous?.apiKey || '';
}

// ---------------------------------------------------------------------------
// 4. 外部导出校验入口
// ---------------------------------------------------------------------------

export function validateProvider(
  value: unknown,
  previous?: SavedProvider,
): SavedProvider {
  const input = object(value);
  assertProviderType(input.type);

  const name = text(input.name, '服务名称', 50);
  if (!name) throw new AppError('请输入服务名称。');

  const { url, baseUrl } = validateProviderBaseUrl(input.type, input.baseUrl);
  const apiKey = resolveApiKey(input.apiKey, previous, url, input.type);

  return {
    id: previous?.id ?? randomUUID(),
    name,
    type: input.type,
    baseUrl,
    apiKey,
    defaultModel: text(input.defaultModel, '默认模型', 128),
  };
}
