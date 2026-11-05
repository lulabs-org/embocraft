import type WebSocket from 'ws';
import type { IncomingMessage } from 'node:http';
import { env } from '../../../core/config/env';
import { originAllowed } from '../../../core/http/origin-policy';
import { AppError } from '../../../core/errors/app-error';
import { asrService, type AsrService } from '../services/asr.service';
import type { SocketRoutes } from '../../../core/transport/socket-routes';
import {
  RealtimeAsrService,
  type AsrBridge,
} from '../services/realtime-asr.service';

/**
 * WebSocket 实时语音识别接口处理器
 *
 * AsyncAPI Channel: `/voice/asr/realtime`
 * 文档与规范请参阅: `/asyncapi-docs` 及 `/asyncapi.json`
 *
 * - Query 参数:
 *   - `language`: 'zh' | 'en' (必填)
 *   - `serviceId`: 已保存的 ASR 服务配置 ID (必填)
 * - Headers:
 *   - `Origin`: 页面来源 (必须在白名单内)
 * - 消息交互:
 *   - 客户端上行: 16000Hz 16-bit 单声道 PCM 原始音频二进制流
 *   - 服务端下行: AsrEvent JSON 格式 (ready, partial, final, finished, error)
 */
export function createAsrSocket(
  storeOrService: AsrService | RealtimeAsrService = asrService,
  bridge?: AsrBridge,
  origin = env.webOrigin(),
) {
  const service =
    storeOrService instanceof RealtimeAsrService
      ? storeOrService
      : new RealtimeAsrService(storeOrService, { bridge });

  return async (client: WebSocket, req: IncomingMessage) => {
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
      if (language !== 'zh' && language !== 'en')
        throw new AppError('不支持的识别语言。');
      if (!serviceId) throw new AppError('请先选择已保存的识别服务。');

      await service.startSession(client, serviceId, language);
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
export function installAsrSocket(routes: SocketRoutes) {
  const socket = createAsrSocket();
  routes.set('/voice/asr/realtime', (client, req) => {
    void socket(client, req);
  });
}
