import { DEFAULT_WHISPER_ASR, type WhisperAsrSettings } from '@voxel/shared';
import { AppError } from '../../../../core/errors/app-error';

/** Settings sent to the independent speech service; model IDs are not local paths. */
export function validateWhisperSettings(
  value: Record<string, unknown>,
): WhisperAsrSettings {
  if (
    typeof value.model !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(value.model) ||
    value.model
      .split('/')
      .some((part) => !part || part === '.' || part === '..')
  )
    throw new AppError('请填写有效的 Whisper 服务模型 ID。');
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
    model: value.model === 'default' ? DEFAULT_WHISPER_ASR.model : value.model,
    temperature: value.temperature,
    prompt: value.prompt.trim(),
  };
}
