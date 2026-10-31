import type { VoiceServiceDraft, VoiceServiceView } from '@voxel/shared';
import { DEFAULT_PIPER_MODEL, PIPER_MODELS } from '@voxel/shared';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../core/errors/app-error';
import { validateVoiceConnection } from '../../../core/audio/voice-service-connection';
import { SpeachesModels } from '../../../core/audio/speaches-models';
import { PiperTts } from '../services/piper.service';
import { RemoteTts } from '../services/remote.service';
import type { SpeechSynthesizer } from '../services/speech-synthesizer';

export type SavedVoice = VoiceServiceDraft & { id: string };
export interface VoiceServicePersistence {
  load(): Promise<SavedVoice[] | undefined>;
  save(values: SavedVoice[]): Promise<void>;
}
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
  private values: SavedVoice[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private deleting = new Set<string>();
  private bindings = new Map<string, string>();
  private listeners = new Set<(actor: string) => void>();
  private running = 0;
  constructor(
    private readonly storage: VoiceServicePersistence,
    private factory: (value: SavedVoice) => SpeechSynthesizer = (value) =>
      value.type === 'speaches' ? new PiperTts(value) : new RemoteTts(value),
  ) {}
  async load() {
    const saved = await this.storage.load();
    if (saved === undefined) {
      const defaultVoice: SavedVoice = {
        ...validateVoiceService({
          name: 'Speaches 语音服务',
          type: 'speaches',
          voice: '',
          speed: 1,
        }),
        id: 'local-default',
      };
      await this.storage.save([defaultVoice]);
      this.values = [defaultVoice];
    } else {
      if (
        !Array.isArray(saved) ||
        saved.length > 20 ||
        new Set(saved.map((voice) => voice.id)).size !== saved.length ||
        saved.some(
          (voice) =>
            typeof voice.id !== 'string' ||
            !/^[a-zA-Z0-9-]{1,80}$/.test(voice.id),
        )
      )
        throw new AppError('语音服务数据库配置格式无效。', 500);
      this.values = saved.map((voice) => ({
        ...validateVoiceService(voice),
        id: voice.id,
      }));
    }
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
        : this.get(input.serviceId as string);
    if (previous && previous.type !== 'speaches')
      throw new AppError('请选择 Speaches 服务。');
    const connection = validateVoiceConnection(input, 'speaches', previous);
    return new SpeachesModels(connection).list(signal);
  }
  list() {
    return this.values.map(publicView);
  }
  get(id: string) {
    const value = this.values.find((v) => v.id === id);
    if (!value || this.deleting.has(id))
      throw new AppError('语音服务不存在，请重新选择。', 404);
    return { ...value };
  }
  private async persist(values: SavedVoice[]) {
    await this.storage.save(values);
  }
  private mutate<T>(fn: () => Promise<T>) {
    const operation = this.queue.then(fn);
    this.queue = operation.catch(() => {});
    return operation;
  }
  save(value: unknown, id?: string) {
    return this.mutate(async () => {
      if (!id && this.values.length >= 20)
        throw new AppError('最多保存 20 个语音服务。');
      const entry = validateVoiceService(value, id ? this.get(id) : undefined);
      const next = id
        ? this.values.map((v) => (v.id === id ? entry : v))
        : [...this.values, entry];
      await this.persist(next);
      this.values = next;
      for (const [actor, service] of this.bindings)
        if (service === id) this.changed(actor);
      return publicView(entry);
    });
  }
  remove(id: string, isUsed: () => boolean) {
    return this.mutate(async () => {
      this.get(id);
      if (isUsed() || [...this.bindings.values()].includes(id))
        throw new AppError(
          '有 Agent 正在引用此服务或保存参数，请先完成更新，并在编辑参数中更换或移除语音服务。',
          409,
        );
      this.deleting.add(id);
      try {
        const next = this.values.filter((v) => v.id !== id);
        await this.persist(next);
        this.values = next;
      } finally {
        this.deleting.delete(id);
      }
    });
  }
  onChange(listener: (actor: string) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(actor: string) {
    for (const listener of this.listeners) listener(actor);
  }
  bind(actor: string, id: string) {
    if (id) this.get(id);
    if (this.bindings.get(actor) === id) return;
    this.changed(actor);
    this.bindings.set(actor, id);
  }
  unbind(actor: string) {
    this.changed(actor);
    this.bindings.delete(actor);
  }
  forActor(actor: string): SpeechSynthesizer {
    // Only trusted Agent management binds cloud services; raw world actions cannot select them.
    const id = this.bindings.get(actor);
    if (id === undefined) return new PiperTts();
    const entry = id ? this.get(id) : undefined;
    return {
      ...(entry?.type === 'browser'
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
    const entry = this.get(id);
    if (entry.type === 'browser')
      throw new AppError('此服务由浏览器朗读，请在浏览器中试听。');
    if (this.running >= 2)
      throw new AppError('语音服务繁忙，请稍后重试。', 429);
    this.running++;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
    try {
      bounded.throwIfAborted();
      const result = await this.factory(entry).synthesize(text, bounded);
      bounded.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof AppError) throw error;
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
