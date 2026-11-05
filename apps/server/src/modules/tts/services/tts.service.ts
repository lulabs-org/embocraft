import type { VoiceServiceView } from '@voxel/shared';
import { DEFAULT_PIPER_MODEL, PIPER_MODELS } from '@voxel/shared';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../core/errors/app-error';
import { domainEvents } from '../../../core/events/domain-events';
import { validateVoiceConnection } from '../../../core/audio/voice-service-connection';
import { SpeachesModels } from '../../../core/audio/speaches-models';
import { PiperTts } from './piper.service';
import { RemoteTts } from './remote.service';
import type { SpeechSynthesizer } from './speech-synthesizer';
import { DatabaseVoiceServicePersistence } from '../persistence/database-voice-services';
import type {
  SavedVoice,
  VoiceServicePersistence,
} from '../persistence/voice-service-types';
export type {
  SavedVoice,
  VoiceServicePersistence,
} from '../persistence/voice-service-types';

const publicView = ({ apiKey, ...value }: SavedVoice): VoiceServiceView => ({
  ...value,
  capability: 'tts',
  hasApiKey: !!apiKey,
});

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

export class TtsService {
  private running = 0;

  constructor(
    private readonly storage: VoiceServicePersistence = new DatabaseVoiceServicePersistence(),
    private readonly factory: (value: SavedVoice) => SpeechSynthesizer = (
      value,
    ) =>
      value.type === 'speaches' ? new PiperTts(value) : new RemoteTts(value),
  ) {}

  private validateSaved(saved: SavedVoice[]): SavedVoice[] {
    if (
      !Array.isArray(saved) ||
      saved.length > 20 ||
      new Set(saved.map((voice) => voice.id)).size !== saved.length
    )
      throw new AppError('语音服务数据库配置格式无效。', 500);
    return saved.map((voice) => this.find(voice));
  }

  private find(voice?: SavedVoice): SavedVoice {
    if (!voice) throw new AppError('语音服务不存在，请重新选择。', 404);
    if (typeof voice.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(voice.id))
      throw new AppError('语音服务数据库配置格式无效。', 500);
    return { ...validateVoiceService(voice), id: voice.id };
  }

  async models(value: unknown, signal?: AbortSignal) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new AppError('语音服务连接配置无效。');
    const input = value as Record<string, unknown>;
    if (input.serviceId !== undefined && typeof input.serviceId !== 'string')
      throw new AppError('语音服务 ID 无效。');
    const previous =
      input.serviceId === undefined
        ? undefined
        : await this.get(input.serviceId as string);
    if (previous && previous.type !== 'speaches')
      throw new AppError('请选择 Speaches 服务。');
    return new SpeachesModels(
      validateVoiceConnection(input, 'speaches', previous),
    ).list(signal);
  }

  async list() {
    return this.validateSaved(await this.storage.load()).map(publicView);
  }

  async get(id: string) {
    return this.find(await this.storage.get(id));
  }

  async save(value: unknown, id?: string) {
    const result = await this.storage.transaction(async (tx) => {
      if (!id && (await tx.count()) >= 20)
        throw new AppError('最多保存 20 个语音服务。');
      const entry = validateVoiceService(
        value,
        id ? this.find(await tx.get(id)) : undefined,
      );
      if (id) await tx.update(entry);
      else await tx.create(entry);
      return publicView(entry);
    });
    if (id) domainEvents.emit('tts.service.changed', { serviceId: id });
    return result;
  }

  async remove(id: string) {
    domainEvents.emit('tts.service.removing', { serviceId: id });
    await this.storage.transaction(async (tx) => {
      this.find(await tx.get(id));
      domainEvents.emit('tts.service.removing', { serviceId: id });
      await tx.remove(id);
    });
    domainEvents.emit('tts.service.changed', { serviceId: id });
  }

  async synthesizer(id: string): Promise<SpeechSynthesizer> {
    const entry = await this.get(id);
    return {
      ...(entry.type === 'browser'
        ? {
            browserVoice: {
              voice: entry.voice,
              speed: entry.speed,
              voiceLanguage: entry.voiceLanguage,
            },
          }
        : {}),
      synthesize: (text, signal) => this.synthesize(id, text, signal),
    };
  }

  async synthesize(id: string, text: string, signal: AbortSignal) {
    if (typeof text !== 'string' || !text.trim() || text.length > 240)
      throw new AppError('试听文字需为 1–240 字。');
    if (this.running >= 2)
      throw new AppError('语音服务繁忙，请稍后重试。', 429);
    this.running++;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
    try {
      bounded.throwIfAborted();
      const entry = await this.get(id);
      bounded.throwIfAborted();
      if (entry.type === 'browser')
        throw new AppError('此服务由浏览器朗读，请在浏览器中试听。');
      const result = await this.factory(entry).synthesize(text, bounded);
      bounded.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted || error instanceof AppError) throw error;
      throw new AppError(
        bounded.aborted
          ? '语音合成超时，请重试。'
          : '语音合成失败，请检查服务配置和音频转换工具。',
        502,
      );
    } finally {
      this.running--;
    }
  }
}

export const ttsService = new TtsService();
