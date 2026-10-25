import { AppError } from '../../common/errors';
import { object, text, integer } from '../../common/validation';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import {
  type AICharacterSettings,
  type ProviderInference,
  type ProviderView,
} from '@voxel/shared';

export type SavedProvider = Omit<ProviderView, 'hasApiKey'> & {
  apiKey: string;
};

export function validateProvider(
  value: unknown,
  previous?: SavedProvider,
): SavedProvider {
  const input = object(value);
  const type = input.type;
  if (type !== 'deepseek' && type !== 'ollama' && type !== 'compatible')
    throw new AppError('不支持此服务类型。');
  const name = text(input.name, '服务名称', 50);
  if (!name) throw new AppError('请输入服务名称。');
  const defaults = {
    deepseek: 'https://api.deepseek.com',
    ollama: 'http://127.0.0.1:11434/v1',
    compatible: '',
  };
  let url: URL;
  try {
    url = new URL(text(input.baseUrl, '接口地址', 500, defaults[type]));
  } catch {
    throw new AppError('请输入有效的 API Base URL。');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const [first, second] = hostname.split('.').map(Number);
  const privateAddress =
    (isIP(hostname) === 4 &&
      (first === 10 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168))) ||
    (isIP(hostname) === 6 &&
      (parseInt(hostname.split(':')[0], 16) & 0xfe00) === 0xfc00);
  const ollamaAddress = loopback || privateAddress;
  const allowHttp = loopback || (type === 'ollama' && ollamaAddress);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowHttp))
  )
    throw new AppError(
      type === 'ollama'
        ? 'Ollama 接口须使用本机或局域网私有 IP 地址，且为 HTTP 或 HTTPS，不能包含密码、查询参数或锚点。'
        : '接口须为 HTTPS 或本机 HTTP 地址，不能包含密码、查询参数或锚点。',
    );
  if (type === 'deepseek' && url.origin !== 'https://api.deepseek.com')
    throw new AppError(
      'DeepSeek 使用官方地址；第三方网关请选择 OpenAI 兼容服务。',
    );
  if (type === 'ollama' && !ollamaAddress)
    throw new AppError('Ollama 仅支持本机或局域网私有 IP 地址。');
  const baseUrl =
    type === 'deepseek'
      ? 'https://api.deepseek.com'
      : url.href.replace(/\/$/, '');
  const apiKey = text(input.apiKey, 'API Key', 4096);
  if (
    previous?.apiKey &&
    !apiKey &&
    (new URL(previous.baseUrl).origin !== url.origin || previous.type !== type)
  )
    throw new AppError('更换服务地址或类型时，请重新填写 API Key。');
  return {
    id: previous?.id ?? randomUUID(),
    name,
    type,
    baseUrl,
    apiKey: apiKey || previous?.apiKey || '',
    defaultModel: text(input.defaultModel, '默认模型', 128),
    inference:
      input.inference === undefined
        ? previous?.inference && validateInference(previous.inference, type)
        : validateInference(object(input.inference), type),
  };
}

export function validateInference(
  input: Record<string, unknown>,
  type: ProviderView['type'],
): ProviderInference {
  const thinking = input.thinking ?? 'disabled';
  const reasoningEffort = input.reasoningEffort ?? 'high';
  if (thinking !== 'enabled' && thinking !== 'disabled')
    throw new AppError('思考模式无效。');
  if (
    typeof reasoningEffort !== 'string' ||
    !['none', 'low', 'high', 'max'].includes(reasoningEffort)
  )
    throw new AppError('推理强度无效。');
  if (type !== 'deepseek' && thinking !== 'disabled')
    throw new AppError('此模型服务暂不提供 DeepSeek 思考参数。');
  return {
    thinking,
    reasoningEffort: reasoningEffort as AICharacterSettings['reasoningEffort'],
    timeoutMs: integer(input.timeoutMs, '推理超时', 60000, 1000, 120000),
    maxTokens: integer(
      input.maxTokens,
      '输出长度',
      thinking === 'enabled' ? 4096 : 512,
      128,
      16384,
    ),
  };
}

export const providerView = ({
  apiKey,
  ...provider
}: SavedProvider): ProviderView => ({ ...provider, hasApiKey: !!apiKey });
