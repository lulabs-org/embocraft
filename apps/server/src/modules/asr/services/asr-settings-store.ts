import { type AsrAssignments, type AsrUse } from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import { listWhisperModels } from '../engines/whisper/whisper.models';
import type { AsrRepositoryPort } from '../ports';
import {
  ASR_USES,
  toAsrServiceView,
  validateAsrService,
  validateWhisperConnection,
  type SavedService,
} from '../domain';

export type { SavedService };

export class AsrSettingsStore {
  private values: SavedService[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private active = new Map<string, number>();
  private deleting = new Set<string>();
  constructor(private readonly storage: AsrRepositoryPort) {}
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
      ...validateAsrService(service),
      id: service.id,
      ...(service.uses ? { uses: service.uses } : {}),
    }));
    if (
      this.values.some(
        (service) =>
          service.uses &&
          (!Array.isArray(service.uses) ||
            service.uses.some((use) => !ASR_USES.includes(use)) ||
            (service.provider !== 'whisper' && service.uses.includes('clip'))),
      )
    )
      throw new AppError('ASR 服务分配格式无效。', 500);
    for (const use of ASR_USES) {
      if (
        this.values.filter((service) => service.uses?.includes(use)).length > 1
      )
        throw new AppError('ASR 服务分配重复。', 500);
    }
  }
  list() {
    return this.values.map(toAsrServiceView);
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
    return listWhisperModels(connection, signal);
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
      if (!ASR_USES.includes(use as AsrUse) || typeof id !== 'string')
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
      const entry = validateAsrService(input, previous);
      if (previous?.uses) entry.uses = previous.uses;
      const next = id
        ? this.values.map((v) => (v.id === id ? entry : v))
        : [...this.values, entry];
      await this.persist(next);
      this.values = next;
      return toAsrServiceView(entry);
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
