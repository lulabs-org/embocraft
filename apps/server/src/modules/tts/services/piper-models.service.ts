import { DEFAULT_PIPER_MODEL } from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import { env } from '../../../core/config/env';
import { readSpeachesResponse } from '../../../core/audio/speaches-response';

/** Read-only readiness checks; Docker startup owns model installation. */
export class PiperModels {
  constructor(
    private endpoint = env.speechEndpoint(),
    private request: typeof fetch = fetch,
  ) {}
  private async installed(signal?: AbortSignal): Promise<Set<string>> {
    try {
      const bounded = AbortSignal.any([
        AbortSignal.timeout(5000),
        ...(signal ? [signal] : []),
      ]);
      const response = await this.request(
        `${this.endpoint}/models?task=text-to-speech`,
        { signal: bounded, redirect: 'error' },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw Error('status');
      }
      const bytes = await readSpeachesResponse(response);
      bounded.throwIfAborted();
      const data = JSON.parse(new TextDecoder().decode(bytes));
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
  async status() {
    try {
      const ready = (await this.installed()).has(DEFAULT_PIPER_MODEL);
      return {
        available: ready,
        reason: ready
          ? 'Piper 本地语音已就绪。'
          : 'Piper 中文模型尚未就绪，请检查语音服务的启动日志。',
      };
    } catch (error) {
      return { available: false, reason: (error as Error).message };
    }
  }
}
