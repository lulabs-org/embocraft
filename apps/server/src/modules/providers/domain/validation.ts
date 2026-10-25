import { AppError } from '../../../common/errors';
import { object, text } from '../../../common/validation';
import type { ProviderDraft, ProviderType } from '@voxel/shared';
import { validateProviderBaseUrl } from './security';

export function assertProviderType(
  type: unknown,
): asserts type is ProviderType {
  if (type !== 'deepseek' && type !== 'ollama' && type !== 'compatible') {
    throw new AppError('不支持此服务类型。');
  }
}

/** Validate one request independently of any previously saved provider. */
export function validateProviderInput(value: unknown): ProviderDraft {
  const input = object(value);
  assertProviderType(input.type);

  const name = text(input.name, '服务名称', 50);
  if (!name) throw new AppError('请输入服务名称。');

  const { baseUrl } = validateProviderBaseUrl(input.type, input.baseUrl);
  return {
    name,
    type: input.type,
    baseUrl,
    apiKey: text(input.apiKey, 'API Key', 4096),
    defaultModel: text(input.defaultModel, '默认模型', 128),
  };
}
