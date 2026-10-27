import {
  DEFAULT_PIPER_MODEL,
  PIPER_MODELS,
  type PiperModelView,
} from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import { speechEndpoint } from '../speech-endpoint';

export function piperModel(id: unknown) {
  const model = PIPER_MODELS.find((value) => value.id === id);
  if (!model) throw new AppError('请选择支持的 Piper 模型。');
  return model;
}

/** One install at a time; downloads belong to the server, not a browser request. */
export class PiperModels {
  private installing?: string;
  private failures = new Map<string, string>();
  constructor(
    private endpoint = speechEndpoint('piper'),
    private request: typeof fetch = fetch,
    private installTimeoutMs = 600000,
  ) {}
  private async installed(signal?: AbortSignal): Promise<Set<string>> {
    try {
      const response = await this.request(
        `${this.endpoint}/models?task=text-to-speech`,
        {
          signal: AbortSignal.any([
            AbortSignal.timeout(5000),
            ...(signal ? [signal] : []),
          ]),
          redirect: 'error',
        },
      );
      if (!response.ok) throw Error('status');
      const data = await response.json();
      if (!Array.isArray(data.data)) throw Error('shape');
      return new Set(data.data.map((model: { id: string }) => model.id));
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AppError(
        '无法连接语音服务，请检查 speech 容器和接口地址。',
        503,
      );
    }
  }
  async list(signal?: AbortSignal): Promise<PiperModelView[]> {
    const installed = await this.installed(signal);
    return PIPER_MODELS.map(({ id, name, language }) => ({
      id,
      name,
      language,
      state:
        this.installing === id
          ? 'installing'
          : installed.has(id)
            ? 'installed'
            : this.failures.has(id)
              ? 'failed'
              : 'missing',
      ...(!installed.has(id) && this.failures.has(id)
        ? { error: this.failures.get(id) }
        : {}),
    }));
  }
  start(id: unknown) {
    const model = piperModel(id);
    if (this.installing && this.installing !== model.id)
      throw new AppError('另一个模型正在安装，请等待完成。', 409);
    if (!this.installing) {
      this.installing = model.id;
      this.failures.delete(model.id);
      void this.install(model.id);
    }
    return { model: model.id, state: 'installing' as const };
  }
  private async install(id: string) {
    const signal = AbortSignal.timeout(this.installTimeoutMs);
    try {
      if (!(await this.installed(signal)).has(id)) {
        const response = await this.request(
          `${this.endpoint}/models/${encodeURIComponent(id)}`,
          {
            method: 'POST',
            signal,
            redirect: 'error',
          },
        );
        await response.body?.cancel();
        if (!response.ok) throw Error('download');
      }
      if (!(await this.installed(signal)).has(id)) throw Error('missing');
    } catch {
      this.failures.set(
        id,
        signal.aborted
          ? '安装等待超时；服务可能仍在下载，请刷新状态后重试。'
          : '模型安装失败，请检查语音服务和模型下载网络后重试。',
      );
    } finally {
      this.installing = undefined;
    }
  }
  async status() {
    try {
      const ready = (await this.installed()).has(DEFAULT_PIPER_MODEL);
      return {
        available: ready,
        reason: ready
          ? 'Piper 本地语音已就绪。'
          : '请在控制台安装 Piper 中文模型。',
      };
    } catch (error) {
      return { available: false, reason: (error as Error).message };
    }
  }
}
