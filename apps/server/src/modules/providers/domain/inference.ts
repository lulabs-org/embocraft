import type { ProviderType } from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import { integer, text } from '../../../core/http/validation';
import type { SavedProvider } from './model';
import { PROVIDER_SPECS } from './specs';

export type InferenceSettings = {
  thinking: 'enabled' | 'disabled';
  reasoningEffort: 'none' | 'low' | 'high' | 'max';
  timeoutMs: number;
  maxTokens: number;
};

const ALLOWED_REASONING_EFFORTS = ['none', 'low', 'high', 'max'] as const;

export const DEFAULT_INFERENCE_TIMEOUT_MS = 60000;
export const OLLAMA_INFERENCE_TIMEOUT_MS = 120000;

/** Model capabilities and provider defaults determine a new inference configuration. */
export function resolveInferenceDefaults(
  model: string,
  providerType?: ProviderType,
): InferenceSettings {
  const timeoutMs =
    providerType === 'ollama'
      ? OLLAMA_INFERENCE_TIMEOUT_MS
      : DEFAULT_INFERENCE_TIMEOUT_MS;
  const thinking = /(reasoner|r1|^o[134])/i.test(model)
    ? 'enabled'
    : 'disabled';
  return {
    thinking,
    reasoningEffort: 'high',
    timeoutMs,
    maxTokens: thinking === 'enabled' ? 4096 : 512,
  };
}

/** Validate the selected model against the configured provider. */
export function validateProviderModel(
  value: unknown,
  provider: SavedProvider,
): string {
  const model = text(value, '模型', 128, provider.defaultModel);
  if (!model || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(model))
    throw new AppError('请输入有效模型 ID。');
  if (provider.type === 'ollama' && /cloud/i.test(model))
    throw new AppError('Ollama 请选择已安装在目标服务上的模型。');
  if (PROVIDER_SPECS[provider.type].requiresApiKey && !provider.apiKey)
    throw new AppError('请先为该模型服务配置 API Key。');
  return model;
}

/** Validate inference options while retaining explicit user choices. */
export function validateInferenceSettings(
  input: Record<string, unknown>,
  model: string,
  providerType?: ProviderType,
): InferenceSettings {
  const defaults = resolveInferenceDefaults(model, providerType);
  const thinking = input.thinking ?? defaults.thinking;
  const reasoningEffort = input.reasoningEffort ?? defaults.reasoningEffort;

  if (thinking !== 'enabled' && thinking !== 'disabled')
    throw new AppError('思考模式无效。');
  if (
    typeof reasoningEffort !== 'string' ||
    !ALLOWED_REASONING_EFFORTS.includes(
      reasoningEffort as (typeof ALLOWED_REASONING_EFFORTS)[number],
    )
  )
    throw new AppError('推理强度无效。');

  return {
    thinking,
    reasoningEffort: reasoningEffort as InferenceSettings['reasoningEffort'],
    timeoutMs: integer(
      input.timeoutMs,
      '推理超时',
      defaults.timeoutMs,
      1000,
      120000,
    ),
    maxTokens: integer(
      input.maxTokens,
      '输出长度',
      thinking === 'enabled' ? 4096 : defaults.maxTokens,
      128,
      16384,
    ),
  };
}
