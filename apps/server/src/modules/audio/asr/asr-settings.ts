import { env } from '../../../config/env';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  DEFAULT_WHISPER_ASR,
  type BailianAsrDraft,
  type AsrServiceDraft,
  type AsrServiceView,
} from '@voxel/shared';
import { validateWhisperSettings } from './whisper-settings';
import { validateSenseVoiceSettings } from './sense-voice-models';
import { AppError } from '../../../common/errors';

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

type SavedService = AsrServiceDraft & { id: string };
const publicView = (value: SavedService): AsrServiceView => {
  // Only the cloud profile owns a secret; server-side engines are returned as saved.
  if (value.provider === 'whisper' || value.provider === 'sense-voice')
    return { ...value };
  const { apiKey, ...settings } = value;
  return { ...settings, hasApiKey: !!apiKey };
};
/** Safe because the switch above already rejects a saved service changing type. */
function previousBailian(
  previous?: SavedService,
): (BailianAsrDraft & { id?: string }) | undefined {
  if (!previous || (previous.provider ?? 'bailian') !== 'bailian')
    return undefined;
  return previous as BailianAsrDraft & { id?: string };
}

function validateService(
  input: unknown,
  previous?: SavedService,
): SavedService {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AppError('识别服务配置无效。');
  const value = input as Record<string, unknown>;
  const provider = value.provider ?? 'bailian';
  if (
    provider !== 'whisper' &&
    provider !== 'bailian' &&
    provider !== 'sense-voice'
  )
    throw new AppError('请选择支持的识别服务类型。');
  if (previous && provider !== (previous.provider ?? 'bailian'))
    throw new AppError('已有服务不能更改类型，请添加新的服务。');
  const settings =
    provider === 'whisper'
      ? { ...validateWhisperSettings(value), provider: 'whisper' as const }
      : provider === 'sense-voice'
        ? {
            ...validateSenseVoiceSettings(value),
            provider: 'sense-voice' as const,
          }
        : {
            ...validateAsrSettings(input, previousBailian(previous)),
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
  constructor(readonly path = env.dataPath('asr-settings.json')) {}
  async load() {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      if (saved?.version === 2 || saved?.version === 3) {
        if (!Array.isArray(saved.services) || saved.services.length > 20)
          throw Error('services');
        const ids = new Set<string>();
        this.values = saved.services.map((value: SavedService) => {
          if (
            typeof value.id !== 'string' ||
            !/^[a-zA-Z0-9-]{1,80}$/.test(value.id) ||
            ['local', 'new'].includes(value.id) ||
            ids.has(value.id)
          )
            throw Error('id');
          ids.add(value.id);
          return { ...validateService(value), id: value.id };
        });
      } else {
        // Upgrade the former singleton without changing its model, region or secret.
        if (saved?.version !== undefined) throw Error('version');
        const settings = validateAsrSettings(saved);
        this.values = [validateService({ ...settings, name: '阿里云百炼' })];
      }
      if (saved?.version !== 3) {
        // Materialize the old fixed Whisper entry once. Deleted profiles stay deleted.
        if (this.values.length < 20) {
          this.values.push(
            validateService({
              ...DEFAULT_WHISPER_ASR,
              provider: 'whisper',
              name: '自托管 Whisper',
            }),
          );
        }
        await this.persist(this.values);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new AppError('无法读取 ASR 配置，请检查服务器配置文件。', 500);
    }
  }
  list() {
    return this.values.map(publicView);
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
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        tmp,
        JSON.stringify({ version: 3, services: values }, null, 2),
        {
          flag: 'wx',
          mode: 0o600,
        },
      );
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
  save(input: unknown, id?: string) {
    return this.mutate(async () => {
      if (!id && this.values.length >= 20)
        throw new AppError('最多保存 20 个识别服务。');
      const entry = validateService(input, id ? this.get(id) : undefined);
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
