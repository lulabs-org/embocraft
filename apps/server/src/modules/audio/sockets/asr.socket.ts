import type WebSocket from 'ws';
import type { IncomingMessage } from 'node:http';
import { env } from '../../../core/config/env';
import { originAllowed } from '../../../core/http/origin-policy';
import { AppError } from '../../../core/errors/app-error';
import type { AsrSettingsStore } from '../persistence/asr-settings-store';
import { bridgeBailianAsr } from '../services/asr/bailian.service';
import type { SocketRoutes } from '../../../core/transport/socket-routes';

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
      if (settings.provider === 'whisper') {
        release();
        throw new AppError('Whisper 服务请使用服务器音频识别接口。');
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
