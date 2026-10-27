import { env } from '../../../config/env';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { VoiceServiceDraft, VoiceServiceView } from '@voxel/shared';
import type { SpeechSynthesizer } from './speech-synthesizer';
import { PiperTts } from './piper-tts';
import { PiperModels, piperModel } from './piper-models';
import { DEFAULT_PIPER_MODEL } from '@voxel/shared';
import { RemoteTts } from './remote-tts';
import { AppError } from '../../../common/errors';

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
  const type = input.type;
  if (
    type !== 'piper' &&
    type !== 'browser' &&
    type !== 'bailian' &&
    type !== 'compatible'
  )
    throw new AppError('请选择支持的语音服务类型。');
  const name = str('name', 50);
  if (!name) throw new AppError('请填写语音服务名称。');
  let baseUrl = '',
    apiKey = '',
    model = '';
  const voice =
    type === 'piper' ? '' : str('voice', type === 'browser' ? 200 : 100);
  if (type === 'piper')
    model = piperModel(input.model ?? DEFAULT_PIPER_MODEL).id;
  const voiceLanguage =
    type === 'browser' ? str('voiceLanguage', 40) : undefined;
  if (voiceLanguage && !/^[a-zA-Z0-9-]+$/.test(voiceLanguage))
    throw new AppError('音色语言格式无效。');
  const voicePattern = /^[\p{L}\p{N}_. ()-]+$/u;
  if (type !== 'browser' && voice && !voicePattern.test(voice))
    throw new AppError('音色名称格式无效。');
  const speed = input.speed ?? 1;
  if (
    typeof speed !== 'number' ||
    !Number.isFinite(speed) ||
    speed < 0.5 ||
    speed > 2
  )
    throw new AppError('语速须为 0.5–2。');
  if (type !== 'piper' && type !== 'browser') {
    let url: URL;
    try {
      url = new URL(str('baseUrl', 500));
    } catch {
      throw new AppError('请填写有效的语音接口地址。');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    )
      throw new AppError(
        '语音接口须为 HTTPS 或本机 HTTP 地址，不能包含凭据或查询参数。',
      );
    baseUrl = url.href.replace(/\/$/, '');
    if (
      type === 'bailian' &&
      ![
        'https://dashscope.aliyuncs.com/api/v1',
        'https://dashscope-intl.aliyuncs.com/api/v1',
      ].includes(baseUrl)
    )
      throw new AppError('百炼请选择北京或新加坡官方接口。');
    apiKey = str('apiKey', 4096);
    if (!apiKey && previous?.apiKey) {
      if (previous.type !== type || previous.baseUrl !== baseUrl)
        throw new AppError('更换类型或地址时，请重新填写密钥。');
      apiKey = previous.apiKey;
    }
    if (!apiKey && !local) throw new AppError('请填写语音服务 API Key。');
    model = str('model', 128);
    if (!model || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/.test(model))
      throw new AppError('请填写有效的语音模型 ID。');
    if (!voice) throw new AppError('请填写音色。');
  }
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
  readonly piperModels = new PiperModels();
  private values: SavedVoice[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private deleting = new Set<string>();
  private bindings = new Map<string, string>();
  private listeners = new Set<(actor: string) => void>();
  private running = 0;
  constructor(
    readonly path = env.dataPath('voice-services.json'),
    private factory: (value: SavedVoice) => SpeechSynthesizer = (value) =>
      value.type === 'piper' ? new PiperTts(value) : new RemoteTts(value),
    private readonly storage?: VoiceServicePersistence,
  ) {}
  async load() {
    if (this.storage) {
      const saved = await this.storage.load();
      if (saved === undefined) {
        const defaultVoice: SavedVoice = {
          ...validateVoiceService({
            name: 'Piper 本地语音',
            type: 'piper',
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
      return;
    }
    try {
      const original = await readFile(this.path, 'utf8');
      const saved: (Omit<SavedVoice, 'type'> & { type: string })[] =
        JSON.parse(original);
      let migrated = false;
      if (
        !Array.isArray(saved) ||
        saved.length > 20 ||
        new Set(saved.map((v) => v.id)).size !== saved.length
      )
        throw Error('invalid');
      this.values = saved.map((value) => {
        if (
          typeof value.id !== 'string' ||
          !/^[a-zA-Z0-9-]{1,80}$/.test(value.id)
        )
          throw Error('invalid');
        if (value.type === 'local') {
          migrated = true;
          value = {
            ...value,
            type: 'piper',
            model: DEFAULT_PIPER_MODEL,
            voice: '',
            name:
              value.name === 'macOS 系统语音' ? 'Piper 本地语音' : value.name,
          };
        }
        return { ...validateVoiceService(value), id: value.id };
      });
      if (migrated) {
        await writeFile(`${this.path}.pre-piper.bak`, original, {
          mode: 0o600,
          flag: 'wx',
        }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
        await this.persist(this.values);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new AppError('无法读取语音服务配置，请检查本地配置文件。', 500);
      this.values = [
        {
          ...validateVoiceService({
            name: 'Piper 本地语音',
            type: 'piper',
            voice: '',
            speed: 1,
          }),
          id: 'local-default',
        },
      ];
      await this.persist(this.values);
    }
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
    if (this.storage) return this.storage.save(values);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(values, null, 2), {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(tmp, this.path);
    } finally {
      await unlink(tmp).catch(() => {});
    }
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
