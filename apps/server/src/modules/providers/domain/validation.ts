import { randomUUID } from 'node:crypto';
import { AppError } from '../../../core/errors/app-error';
import { object, text } from '../../../core/http/validation';
import type { ProviderType } from '@voxel/shared';
import { PROVIDER_SPECS, type SavedProvider } from './model';

const SUPPORTED_TYPES = ['deepseek', 'ollama', 'compatible', 'gemini'] as const;
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

// ============================================================================
// 1. 底层清洗：Base URL 规范化与安全审计
// ============================================================================

/** 校验并规范化服务 Base URL，阻止非法协议注入、凭据泄露及非法外联 */
function validateProviderBaseUrl(type: ProviderType, rawUrl: unknown): string {
  let url: URL;
  try {
    const raw = rawUrl === undefined ? PROVIDER_SPECS[type].defaultUrl : rawUrl;
    url = new URL(typeof raw === 'string' ? raw.trim() : '');
  } catch {
    throw new AppError('请输入有效的 API Base URL。');
  }

  const allowHttp = LOCAL_HOSTNAMES.has(url.hostname) || type === 'ollama';
  const isValidProtocol =
    url.protocol === 'https:' || (allowHttp && url.protocol === 'http:');

  if (
    !isValidProtocol ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new AppError(
      '接口须为 HTTPS 或本机 HTTP 地址，不能包含密码、查询参数或锚点。',
    );
  }

  if (type === 'deepseek' && url.origin !== 'https://api.deepseek.com') {
    throw new AppError(
      'DeepSeek 使用官方地址；第三方网关请选择 OpenAI 兼容服务。',
    );
  }

  const normalized = url.href.replace(/\/$/, '');
  if (type === 'gemini' && normalized !== PROVIDER_SPECS.gemini.defaultUrl) {
    throw new AppError(
      'Gemini 使用官方地址 https://generativelanguage.googleapis.com/v1beta。',
    );
  }
  return normalized;
}

/** 校验并组装模型服务实体（支持新建分配 UUID、更新继承旧 ID/密钥、及显式指定 ID） */
export function validateProvider(
  raw: unknown,
  previous?: SavedProvider,
): SavedProvider {
  const input = object(raw);

  let id = previous?.id;
  if (!id) {
    if (input.id !== undefined) {
      if (
        typeof input.id !== 'string' ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(input.id)
      ) {
        throw new AppError('无效的模型服务 ID。');
      }
      id = input.id;
    } else {
      id = randomUUID();
    }
  }

  const type = input.type as ProviderType;
  if (!SUPPORTED_TYPES.includes(type)) {
    throw new AppError('不支持此服务类型。');
  }

  const name = text(input.name, '服务名称', 50);
  if (!name) throw new AppError('请输入服务名称。');

  const baseUrl = validateProviderBaseUrl(type, input.baseUrl);
  let apiKey = text(input.apiKey, 'API Key', 4096);

  // 跨服务地址或类型时禁止隐式继承 API Key；同地址同类型未填时安全继承
  if (previous?.apiKey && !apiKey) {
    if (
      new URL(previous.baseUrl).origin !== new URL(baseUrl).origin ||
      previous.type !== type
    ) {
      throw new AppError('更换服务地址或类型时，请重新填写 API Key。');
    }
    apiKey = previous.apiKey;
  }

  return {
    id,
    name,
    type,
    baseUrl,
    apiKey,
    defaultModel: text(input.defaultModel, '默认模型', 128),
  };
}
