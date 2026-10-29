import type WebSocket from 'ws';
import type { IncomingMessage } from 'node:http';
import { env } from '../../../config/env';
import { originAllowed } from '../../../common/origin-policy';
import { AppError } from '../../../common/errors';
import type { AsrSettingsStore } from './asr-settings';
import { bridgeBailianAsr } from './bailian-asr';
import type { SocketRoutes } from '../../../transport/socket-routes';

export type AsrBridge = Parameters<typeof createAsrSocket>[1];

/** One server's ASR handler owns the concurrency limit and service references. */
export function createAsrSocket(
  store: AsrSettingsStore,
  bridge = bridgeBailianAsr,
  origin = env.webOrigin(),
) {
  let running = 0;
  return (client: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    client.on('error', () => {});
    const reject = (message: string) => {
      client.send(JSON.stringify({ type: 'error', message }));
      client.close();
    };
    const language = url.searchParams.get('language');
    const serviceId = url.searchParams.get('serviceId');
    try {
      if (!originAllowed(req.headers.origin, origin))
        throw new AppError('不允许此页面访问实时识别。');
      if (running >= 2) throw new AppError('实时识别服务繁忙，请稍后重试。');
      if (language !== 'zh' && language !== 'en')
        throw new AppError('不支持的识别语言。');
      if (!serviceId) throw new AppError('请先选择已保存的识别服务。');
      const { settings, release } = store.acquire(serviceId);
      if (settings.provider !== 'bailian') {
        release();
        // Only Bailian streams over WS; the others decode HTTP snapshots instead.
        const engine =
          settings.provider === 'sense-voice'
            ? 'SenseVoice'
            : settings.provider === 'openai'
              ? 'OpenAI 兼容识别接口'
              : 'Whisper';
        throw new AppError(
          `${engine} 使用服务器音频识别接口，无需实时通道；请选择阿里云实时识别。`,
        );
      }
      running++;
      client.once('close', () => {
        running--;
        release();
      });
      bridge(client, settings, language);
    } catch (error) {
      reject(
        error instanceof AppError
          ? error.message
          : '无法启动识别，请检查服务配置。',
      );
    }
  };
}

/** Registers the realtime ASR socket on the shared Colyseus socket server. */
export function installAsrSocket(
  routes: SocketRoutes,
  deps: {
    settings: AsrSettingsStore;
    bridge?: AsrBridge;
    origin?: string;
  },
) {
  routes.set(
    '/voice/asr/realtime',
    createAsrSocket(deps.settings, deps.bridge, deps.origin),
  );
}
