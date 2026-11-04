import { randomUUID } from 'node:crypto';
import type { LiveVoiceDraft, LiveVoiceView } from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';

export type SavedLiveVoice = LiveVoiceDraft & { id: string };
export interface LiveVoiceRepository {
  load(): Promise<SavedLiveVoice[]>;
  save(values: SavedLiveVoice[]): Promise<void>;
}

function validate(value: unknown, previous?: SavedLiveVoice): SavedLiveVoice {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppError('实时语音服务配置无效。');
  const input = value as Record<string, unknown>;
  if (input.provider !== 'openai' && input.provider !== 'gemini')
    throw new AppError('请选择支持的实时语音服务。');
  if (previous && previous.provider !== input.provider)
    throw new AppError('已有服务不能更改类型，请添加新服务。');
  if (
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 50 ||
    /[\r\n\0]/.test(input.name)
  )
    throw new AppError('请填写 1–50 字的服务名称。');
  if (
    typeof input.model !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.model)
  )
    throw new AppError('实时语音模型无效。');
  if (
    typeof input.voice !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(input.voice)
  )
    throw new AppError('实时语音音色无效。');
  if (
    typeof input.apiKey !== 'string' ||
    input.apiKey.length > 4096 ||
    /[\r\n\0]/.test(input.apiKey)
  )
    throw new AppError('API Key 格式无效。');
  const apiKey = input.apiKey.trim() || previous?.apiKey || '';
  if (!apiKey) throw new AppError('请填写 API Key。');
  return {
    id: previous?.id ?? randomUUID(),
    provider: input.provider,
    name: input.name.trim(),
    model: input.model,
    voice: input.voice,
    apiKey,
  };
}
const publicView = ({
  apiKey,
  ...settings
}: SavedLiveVoice): LiveVoiceView => ({ ...settings, hasApiKey: !!apiKey });

/** Credentials remain on the server; active sessions lease services until they close. */
export class LiveVoiceStore {
  private values: SavedLiveVoice[] = [];
  private active = new Map<string, number>();
  private deleting = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly repository: LiveVoiceRepository) {}
  async load() {
    const saved = await this.repository.load();
    if (
      saved.length > 20 ||
      new Set(saved.map((item) => item.id)).size !== saved.length ||
      saved.some((item) => !/^[a-zA-Z0-9-]{1,80}$/.test(item.id))
    )
      throw new AppError('实时语音服务配置无效。', 500);
    this.values = saved.map((item) => ({ ...validate(item), id: item.id }));
  }
  list() {
    return this.values.map(publicView);
  }
  get(id: string) {
    const found = this.values.find((item) => item.id === id);
    if (!found || this.deleting.has(id))
      throw new AppError('实时语音服务不存在。', 404);
    return { ...found };
  }
  acquire(id: string) {
    const settings = this.get(id);
    this.active.set(id, (this.active.get(id) ?? 0) + 1);
    let released = false;
    return {
      settings,
      release: () => {
        if (released) return;
        released = true;
        const remaining = (this.active.get(id) ?? 1) - 1;
        if (remaining) this.active.set(id, remaining);
        else this.active.delete(id);
      },
    };
  }
  private mutate<T>(operation: () => Promise<T>) {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  save(value: unknown, id?: string) {
    return this.mutate(async () => {
      if (!id && this.values.length >= 20)
        throw new AppError('最多保存 20 个实时语音服务。');
      const saved = validate(value, id ? this.get(id) : undefined);
      const next = id
        ? this.values.map((item) => (item.id === id ? saved : item))
        : [...this.values, saved];
      await this.repository.save(next);
      this.values = next;
      return publicView(saved);
    });
  }
  remove(id: string) {
    return this.mutate(async () => {
      this.get(id);
      if (this.active.has(id))
        throw new AppError('实时语音服务正在使用中。', 409);
      this.deleting.add(id);
      try {
        const next = this.values.filter((item) => item.id !== id);
        await this.repository.save(next);
        this.values = next;
      } finally {
        this.deleting.delete(id);
      }
    });
  }
}
