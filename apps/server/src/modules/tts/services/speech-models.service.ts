import { AppError } from '../../../core/errors/app-error';
import { validateVoiceConnection } from '../../../core/audio/voice-service-connection';
import type { SavedVoice } from '../domain/voice-service-validation';
import type { SpeechModelQuery } from '../ports';

export class SpeechModelsService {
  constructor(
    private readonly getVoice: (id: string) => Promise<SavedVoice>,
    private readonly queryModels: SpeechModelQuery,
  ) {}

  async models(value: unknown, signal?: AbortSignal) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new AppError('语音服务连接配置无效。');
    const input = value as Record<string, unknown>;
    if (input.serviceId !== undefined && typeof input.serviceId !== 'string')
      throw new AppError('语音服务 ID 无效。');
    const previous =
      input.serviceId === undefined
        ? undefined
        : await this.getVoice(input.serviceId as string);
    if (previous && previous.type !== 'speaches')
      throw new AppError('请选择 Speaches 服务。');
    return this.queryModels(
      validateVoiceConnection(input, 'speaches', previous),
      signal,
    );
  }
}
