import { DEFAULT_WHISPER_ASR, type WhisperAsrDraft } from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import { validateVoiceConnection } from '../../../core/audio/voice-service-connection';

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
