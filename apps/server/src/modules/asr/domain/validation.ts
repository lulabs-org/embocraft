import { randomUUID } from 'node:crypto';
import {
  DEFAULT_WHISPER_ASR,
  type BailianAsrDraft,
  type WhisperAsrDraft,
} from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import { validateVoiceConnection } from '../../../core/audio/voice-service-connection';
import type { SavedService } from './model';

// ============================================================================
// 1. 阿里云百炼配置校验与端点计算
// ============================================================================

export function validateBailianSettings(
  value: unknown,
  previous?: BailianAsrDraft,
): BailianAsrDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppError('识别服务配置无效。');
  const v = value as Record<string, unknown>;
  if (v.region !== 'beijing' && v.region !== 'singapore')
    throw new AppError('请选择北京或新加坡地域。');
  if (v.model !== 'fun-asr-realtime' && v.model !== 'paraformer-realtime-v2')
    throw new AppError('请选择支持的实时识别模型。');
  if (
    typeof v.workspaceId !== 'string' ||
    !/^[a-zA-Z0-9-]{0,80}$/.test(v.workspaceId)
  )
    throw new AppError('业务空间 ID 格式无效。');
  if (
    typeof v.apiKey !== 'string' ||
    v.apiKey.length > 4096 ||
    /[\r\n\0]/.test(v.apiKey)
  )
    throw new AppError('API Key 格式无效。');
  let apiKey = v.apiKey.trim();
  if (!apiKey && previous?.apiKey) {
    if (previous.region !== v.region || previous.workspaceId !== v.workspaceId)
      throw new AppError('更换地域或业务空间时，请重新填写 API Key。');
    apiKey = previous.apiKey;
  }
  if (!apiKey) throw new AppError('请填写百炼 API Key。');
  return {
    region: v.region,
    workspaceId: v.workspaceId,
    model: v.model,
    apiKey,
  };
}

export function bailianAsrEndpoint(settings: BailianAsrDraft): string {
  const host = settings.workspaceId
    ? `${settings.workspaceId}.${settings.region === 'beijing' ? 'cn-beijing' : 'ap-southeast-1'}.maas.aliyuncs.com`
    : settings.region === 'beijing'
      ? 'dashscope.aliyuncs.com'
      : 'dashscope-intl.aliyuncs.com';
  return `wss://${host}/api-ws/v1/inference`;
}

// ============================================================================
// 2. Whisper / Speaches 配置校验
// ============================================================================

export function validateWhisperConnection(
  value: Record<string, unknown>,
  previous?: WhisperAsrDraft,
) {
  const { baseUrl, apiKey } = validateVoiceConnection(
    value,
    'speaches',
    previous
      ? {
          type: 'speaches',
          baseUrl: previous.baseUrl ?? '',
          apiKey: previous.apiKey ?? '',
        }
      : undefined,
  );
  return { baseUrl, apiKey };
}

/** Settings sent to the independent speech service; model IDs are not local paths. */
export function validateWhisperSettings(
  value: Record<string, unknown>,
  previous?: WhisperAsrDraft,
): WhisperAsrDraft {
  if (
    typeof value.model !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/.test(value.model) ||
    value.model
      .split('/')
      .some((part) => !part || part === '.' || part === '..')
  )
    throw new AppError('请选择有效的 Speaches 识别模型。');
  if (
    typeof value.temperature !== 'number' ||
    !Number.isFinite(value.temperature) ||
    value.temperature < 0 ||
    value.temperature > 1
  )
    throw new AppError('采样温度须在 0–1 之间。');
  if (
    typeof value.prompt !== 'string' ||
    value.prompt.length > 500 ||
    value.prompt.includes('\0')
  )
    throw new AppError('提示词不能超过 500 字或包含空字符。');
  return {
    ...validateWhisperConnection(value, previous),
    model: value.model === 'default' ? DEFAULT_WHISPER_ASR.model : value.model,
    temperature: value.temperature,
    prompt: value.prompt.trim(),
  };
}

// ============================================================================
// 3. 通用 ASR 服务实体校验与组装
// ============================================================================

export function validateAsrService(
  input: unknown,
  previous?: SavedService,
): SavedService {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AppError('识别服务配置无效。');
  const value = input as Record<string, unknown>;
  const provider = value.provider ?? 'bailian';
  if (provider !== 'whisper' && provider !== 'bailian')
    throw new AppError('请选择支持的识别服务类型。');
  if (previous && provider !== (previous.provider ?? 'bailian'))
    throw new AppError('已有服务不能更改类型，请添加新的服务。');

  const settings =
    provider === 'whisper'
      ? {
          ...validateWhisperSettings(
            value,
            previous?.provider === 'whisper' ? previous : undefined,
          ),
          provider: 'whisper' as const,
        }
      : {
          ...validateBailianSettings(
            input,
            previous?.provider === 'whisper' ? undefined : previous,
          ),
          provider: 'bailian' as const,
        };

  const name = value.name;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 50 ||
    /[\r\n\0]/.test(name)
  )
    throw new AppError('请填写 1–50 字的识别服务名称。');

  return {
    ...settings,
    name: name.trim(),
    id: previous?.id ?? randomUUID(),
  };
}

