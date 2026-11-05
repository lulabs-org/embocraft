import type WebSocket from 'ws';
import type { BailianAsrDraft, LiveAsrDraft } from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import type { AsrSettingsStore } from './asr-settings-store';
import { bridgeOpenAIAsr } from '../engines/openai/openai.adapter';
import { bridgeGeminiAsr } from '../engines/gemini/gemini.adapter';
import { bridgeBailianAsr } from '../engines/bailian/bailian.adapter';

export type AsrBridge = (
  client: WebSocket,
  settings: BailianAsrDraft,
  language: string,
) => void | (() => void);

type LiveAsrBridge = (
  client: WebSocket,
  settings: LiveAsrDraft,
  language: string,
) => void | (() => void);

const bridgeLiveAsr: LiveAsrBridge = (client, settings, language) =>
  settings.provider === 'openai'
    ? bridgeOpenAIAsr(client, settings, language)
    : bridgeGeminiAsr(client, settings, language);

export interface RealtimeAsrServiceOptions {
  maxConcurrency?: number;
  bridge?: AsrBridge;
  liveBridge?: LiveAsrBridge;
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
  private readonly liveBridge: LiveAsrBridge;

  constructor(
    private readonly store: AsrSettingsStore,
    options?: RealtimeAsrServiceOptions | AsrBridge,
  ) {
    if (typeof options === 'function') {
      this.maxConcurrency = 2;
      this.bridge = options;
      this.liveBridge = bridgeLiveAsr;
    } else {
      this.maxConcurrency = options?.maxConcurrency ?? 2;
      this.bridge = options?.bridge ?? bridgeBailianAsr;
      this.liveBridge = options?.liveBridge ?? bridgeLiveAsr;
    }
  }

  get runningSessions(): number {
    return this.running;
  }

  async startSession(
    client: WebSocket,
    serviceId: string,
    language: string,
  ): Promise<void> {
    if (this.running >= this.maxConcurrency) {
      throw new AppError('实时识别服务繁忙，请稍后重试。');
    }

    this.running++;
    let closed = false;
    let release: (() => void) | undefined;
    const onClose = () => {
      closed = true;
      this.running--;
      release?.();
    };
    client.once('close', onClose);
    try {
      const acquired = await this.store.acquire(serviceId);
      release = acquired.release;
      if (closed) {
        release();
        return;
      }
      const { settings } = acquired;
      if (settings.provider === 'whisper')
        throw new AppError('Whisper 服务请使用服务器音频识别接口。');
      if (settings.provider === 'openai' || settings.provider === 'gemini')
        this.liveBridge(client, settings, language);
      else this.bridge(client, settings, language);
    } catch (error) {
      if (!closed) {
        client.off('close', onClose);
        this.running--;
        release?.();
      }
      if (!closed) throw error;
    }
  }
}
