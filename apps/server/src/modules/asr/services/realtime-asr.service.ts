import type WebSocket from 'ws';
import type { BailianAsrDraft } from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import type { AsrSettingsStore } from './asr-settings-store';
import { bridgeBailianAsr } from '../engines/bailian/bailian.adapter';

export type AsrBridge = (
  client: WebSocket,
  settings: BailianAsrDraft,
  language: string,
) => void | (() => void);

export interface RealtimeAsrServiceOptions {
  maxConcurrency?: number;
  bridge?: AsrBridge;
}

/**
 * 实时语音识别协调服务
 *
 * 负责：
 * - 实时流识别并发会话数量限制与排队防护
 * - ASR 服务配置租约获取 (acquire) 与连接关闭时的释放 (release)
 * - 校验 Provider 是否支持实时流式识别
 * - 调度并桥接客户端 WebSocket 与具体的流式引擎
 */
export class RealtimeAsrService {
  private running = 0;
  private readonly maxConcurrency: number;
  private readonly bridge: AsrBridge;

  constructor(
    private readonly store: AsrSettingsStore,
    options?: RealtimeAsrServiceOptions | AsrBridge,
  ) {
    if (typeof options === 'function') {
      this.maxConcurrency = 2;
      this.bridge = options;
    } else {
      this.maxConcurrency = options?.maxConcurrency ?? 2;
      this.bridge = options?.bridge ?? bridgeBailianAsr;
    }
  }

  get runningSessions(): number {
    return this.running;
  }

  startSession(client: WebSocket, serviceId: string, language: string): void {
    if (this.running >= this.maxConcurrency) {
      throw new AppError('实时识别服务繁忙，请稍后重试。');
    }

    const { settings, release } = this.store.acquire(serviceId);
    if (settings.provider === 'whisper') {
      release();
      throw new AppError('Whisper 服务请使用服务器音频识别接口。');
    }

    this.running++;
    client.once('close', () => {
      this.running--;
      release();
    });

    this.bridge(client, settings, language);
  }
}

