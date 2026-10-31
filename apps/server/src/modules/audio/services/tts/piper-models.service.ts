import { DEFAULT_PIPER_MODEL } from '@voxel/shared';
import { AppError } from '../../../../core/errors/app-error';
import { speechEndpoint } from '../../speech-endpoint';

/** Read-only readiness checks; Docker startup owns model installation. */
export class PiperModels {
  constructor(
    private endpoint = speechEndpoint(),
    private request: typeof fetch = fetch,
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
