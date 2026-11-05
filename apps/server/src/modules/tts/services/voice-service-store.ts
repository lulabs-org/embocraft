import type { VoiceServiceView } from '@voxel/shared';
import { DEFAULT_PIPER_MODEL, PIPER_MODELS } from '@voxel/shared';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../core/errors/app-error';
import { validateVoiceConnection } from '../../../core/audio/voice-service-connection';
import { SpeachesModels } from '../../../core/audio/speaches-models';
import { VoiceRuntime } from './voice-runtime';
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

export class VoiceServiceStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly runtime: VoiceRuntime;

  constructor(
    private readonly storage: VoiceServicePersistence = new DatabaseVoiceServicePersistence(),
    factory?: (value: SavedVoice) => SpeechSynthesizer,
    private readonly hasReference: (id: string) => boolean = () => false,
  ) {
    this.runtime = new VoiceRuntime(
      async (id) => this.find(await this.storage.get(id)),
      factory,
    );
  }

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

  get(id: string) {
    return this.runtime.get(id);
  }

  private mutate<T>(fn: () => Promise<T>) {
    const operation = this.queue.then(fn);
    this.queue = operation.catch(() => {});
    return operation;
  }

  save(value: unknown, id?: string) {
    return this.mutate(async () => {
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
      if (id) this.runtime.serviceChanged(id);
      return result;
    });
  }

  remove(id: string, isUsed: () => boolean = () => false) {
    return this.mutate(() =>
      this.runtime.remove(
        id,
        () => isUsed() || this.hasReference(id),
        async (assertUnused) => {
          await this.storage.transaction(async (tx) => {
            this.find(await tx.get(id));
            assertUnused();
            await tx.remove(id);
          });
        },
      ),
    );
  }

  onChange(listener: (actor: string) => void) {
    return this.runtime.onChange(listener);
  }
  bind(actor: string, id: string) {
    return this.runtime.bind(actor, id);
  }
  unbind(actor: string) {
    this.runtime.unbind(actor);
  }
  forActor(actor: string) {
    return this.runtime.forActor(actor);
  }
  synthesize(id: string, text: string, signal: AbortSignal) {
    return this.runtime.synthesize(id, text, signal);
  }
}
