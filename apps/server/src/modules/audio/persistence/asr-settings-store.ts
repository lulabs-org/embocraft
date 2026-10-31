import {
  type AsrAssignments,
  type AsrUse,
  type AsrServiceDraft,
  type AsrServiceView,
  type BailianAsrDraft,
} from '@voxel/shared';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../core/errors/app-error';
import {
  validateWhisperConnection,
  validateWhisperSettings,
} from '../services/asr/whisper-settings';
import { SpeachesModels } from '../services/speaches-models.service';

export function validateAsrSettings(
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

export function asrEndpoint(settings: BailianAsrDraft) {
  const host = settings.workspaceId
    ? `${settings.workspaceId}.${settings.region === 'beijing' ? 'cn-beijing' : 'ap-southeast-1'}.maas.aliyuncs.com`
    : settings.region === 'beijing'
      ? 'dashscope.aliyuncs.com'
      : 'dashscope-intl.aliyuncs.com';
  return `wss://${host}/api-ws/v1/inference`;
}

// Assignments live alongside the service in its existing database JSON record.
export type SavedService = AsrServiceDraft & { id: string; uses?: AsrUse[] };
const uses: AsrUse[] = ['chat', 'spatial', 'clip'];
export interface AsrServicePersistence {
  load(): Promise<SavedService[]>;
  save(values: SavedService[]): Promise<void>;
}
const publicView = ({
  uses: _uses,
  ...value
}: SavedService): AsrServiceView => {
  const { apiKey, ...settings } = value;
  return { ...settings, hasApiKey: !!apiKey };
};
function validateService(
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
          ...validateAsrSettings(
            input,
            previous?.provider === 'whisper' ? undefined : previous,
          ),
          provider: 'bailian' as const,
        };
  const name = (input as Record<string, unknown>).name;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 50 ||
    /[\r\n\0]/.test(name)
  )
    throw new AppError('请填写 1–50 字的识别服务名称。');
  return { ...settings, name: name.trim(), id: previous?.id ?? randomUUID() };
}

export class AsrSettingsStore {
  private values: SavedService[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private active = new Map<string, number>();
  private deleting = new Set<string>();
  constructor(private readonly storage: AsrServicePersistence) {}
  async load() {
    const saved = await this.storage.load();
    if (
      !Array.isArray(saved) ||
      saved.length > 20 ||
      new Set(saved.map((service) => service.id)).size !== saved.length ||
      saved.some(
        (service) =>
          typeof service.id !== 'string' ||
          !/^[a-zA-Z0-9-]{1,80}$/.test(service.id) ||
          ['local', 'new'].includes(service.id),
      )
    )
      throw new AppError('ASR 数据库配置格式无效。', 500);
    this.values = saved.map((service) => ({
      ...validateService(service),
      id: service.id,
      ...(service.uses ? { uses: service.uses } : {}),
    }));
    if (
      this.values.some(
        (service) =>
          service.uses &&
          (!Array.isArray(service.uses) ||
            service.uses.some((use) => !uses.includes(use)) ||
            (service.provider !== 'whisper' && service.uses.includes('clip'))),
      )
    )
      throw new AppError('ASR 服务分配格式无效。', 500);
    for (const use of uses) {
      if (
        this.values.filter((service) => service.uses?.includes(use)).length > 1
      )
        throw new AppError('ASR 服务分配重复。', 500);
    }
  }
  list() {
    return this.values.map(publicView);
  }
  async models(value: unknown, signal?: AbortSignal) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new AppError('识别服务连接配置无效。');
    const input = value as Record<string, unknown>;
    if (input.serviceId !== undefined && typeof input.serviceId !== 'string')
      throw new AppError('识别服务 ID 无效。');
    const previous =
      input.serviceId === undefined
        ? undefined
        : this.get(input.serviceId as string);
    if (previous && previous.provider !== 'whisper')
      throw new AppError('请选择 Speaches 识别服务。');
    const connection = validateWhisperConnection(
      input,
      previous?.provider === 'whisper' ? previous : undefined,
    );
    return new SpeachesModels(connection).list(
      signal,
      'automatic-speech-recognition',
    );
  }
  assignments(): AsrAssignments {
    // Older databases need no console visit or name-based client initialization.
    const whisper = this.values.find(
      (service) => service.provider === 'whisper',
    );
    const choice = (use: AsrUse) => {
      const selected =
        this.values.find((service) => service.uses?.includes(use)) ??
        whisper ??
        (use === 'clip' ? undefined : this.values[0]);
      return selected
        ? {
            id: selected.id,
            name: selected.name,
            provider: selected.provider ?? 'bailian',
          }
        : null;
    };
    return {
      chat: choice('chat'),
      spatial: choice('spatial'),
      clip: choice('clip'),
    };
  }
  assign(use: unknown, id: unknown) {
    return this.mutate(async () => {
      if (!uses.includes(use as AsrUse) || typeof id !== 'string')
        throw new AppError('识别服务分配无效。');
      const selected = this.get(id);
      if (use === 'clip' && selected.provider !== 'whisper')
        throw new AppError('语音消息转文字需要 Whisper 服务。');
      const next = this.values.map((service) => ({
        ...service,
        uses: [
          ...(service.uses ?? []).filter((item) => item !== use),
          ...(service.id === id ? [use as AsrUse] : []),
        ],
      }));
      await this.persist(next);
      this.values = next;
      return this.assignments();
    });
  }
  get(id: string) {
    const value = this.values.find((value) => value.id === id);
    if (!value || this.deleting.has(id))
      throw new AppError('识别服务不存在，请重新选择或添加服务。', 404);
    return { ...value };
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
        const count = (this.active.get(id) ?? 1) - 1;
        if (count) this.active.set(id, count);
        else this.active.delete(id);
      },
    };
  }
  private async persist(values: SavedService[]) {
    await this.storage.save(values);
  }
  private mutate<T>(fn: () => Promise<T>) {
    const operation = this.queue.then(fn);
    this.queue = operation.catch(() => {});
    return operation;
  }
  save(input: unknown, id?: string) {
    return this.mutate(async () => {
      if (!id && this.values.length >= 20)
        throw new AppError('最多保存 20 个识别服务。');
      const previous = id ? this.get(id) : undefined;
      const entry = validateService(input, previous);
      if (previous?.uses) entry.uses = previous.uses;
      const next = id
        ? this.values.map((v) => (v.id === id ? entry : v))
        : [...this.values, entry];
      await this.persist(next);
      this.values = next;
      return publicView(entry);
    });
  }
  remove(id: string) {
    return this.mutate(async () => {
      this.get(id);
      if (this.active.has(id))
        throw new AppError('此服务正在识别，请先结束录音后再删除。', 409);
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
}
