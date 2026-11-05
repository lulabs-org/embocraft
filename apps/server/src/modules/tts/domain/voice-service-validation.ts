import {
  DEFAULT_PIPER_MODEL,
  PIPER_MODELS,
  type VoiceServiceDraft,
} from '@voxel/shared';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../core/errors/app-error';
import { validateVoiceConnection } from '../../../core/audio/voice-service-connection';

export type SavedVoice = VoiceServiceDraft & { id: string };

export function validateVoiceService(
  value: unknown,
  previous?: SavedVoice,
): SavedVoice {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppError('语音服务配置无效。');
  const input = value as Record<string, unknown>;
  const str = (key: string, max: number, fallback = '') => {
    const v = input[key] ?? fallback;
    if (typeof v !== 'string' || v.length > max || /[\r\n\0]/.test(v))
      throw new AppError(`${key} 格式无效。`);
    return v.trim();
  };
  // Existing catalogs and older clients used the engine name for this service.
  const type = input.type === 'piper' ? 'speaches' : input.type;
  if (
    type !== 'speaches' &&
    type !== 'browser' &&
    type !== 'bailian' &&
    type !== 'compatible'
  )
    throw new AppError('请选择支持的语音服务类型。');
  const name = str('name', 50);
  if (!name) throw new AppError('请填写语音服务名称。');
  const { baseUrl, apiKey } = validateVoiceConnection(input, type, previous);
  const model =
    type === 'browser'
      ? ''
      : str('model', 200, type === 'speaches' ? DEFAULT_PIPER_MODEL : '');
  if (
    type !== 'browser' &&
    (!model || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/.test(model))
  )
    throw new AppError('请填写有效的语音模型 ID。');
  // Old Piper profiles had no voice field; retain their exact existing voice.
  const voice =
    str('voice', type === 'browser' || type === 'speaches' ? 200 : 100) ||
    (type === 'speaches'
      ? (PIPER_MODELS.find((item) => item.id === model)?.voice ?? '')
      : '');
  if (type !== 'browser' && !voice) throw new AppError('请选择或填写音色。');
  const voiceLanguage =
    type === 'browser' ? str('voiceLanguage', 40) : undefined;
  if (voiceLanguage && !/^[a-zA-Z0-9-]+$/.test(voiceLanguage))
    throw new AppError('音色语言格式无效。');
  const voicePattern = /^[\p{L}\p{N}_. ()-]+$/u;
  if (
    type !== 'browser' &&
    type !== 'speaches' &&
    voice &&
    !voicePattern.test(voice)
  )
    throw new AppError('音色名称格式无效。');
  const speed = input.speed ?? 1;
  if (
    typeof speed !== 'number' ||
    !Number.isFinite(speed) ||
    speed < 0.5 ||
    speed > 2
  )
    throw new AppError('语速须为 0.5–2。');
  return {
    id: previous?.id ?? randomUUID(),
    name,
    type,
    baseUrl,
    apiKey,
    model,
    voice,
    ...(voiceLanguage ? { voiceLanguage } : {}),
    speed: type === 'bailian' ? 1 : speed,
  };
}
