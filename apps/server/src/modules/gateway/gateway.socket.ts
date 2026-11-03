import type WebSocket from 'ws';
import type { IncomingMessage } from 'node:http';
import type { ConsoleSyncEvents } from '../console-sync';
import {
  ManagementError,
  MANAGEMENT_EVENTS_VERSION,
  MAX_EVENT_REQUEST_BYTES,
  type ManagementFrame,
} from '@voxel/shared/management';
import { parseEventConnect } from './validation';
import { publicError } from '../../core/errors/public-error';
import type { GatewayAuth } from './auth.service';
import type { SocketRoutes } from '../../core/transport/socket-routes';

/**
 * WebSocket AI 角色控制台网关处理器
 *
 * AsyncAPI Channel: `/ai-characters/gateway`
 * 文档与规范请参阅: `/asyncapi-docs` 及 `/asyncapi.json`
 *
 * - 认证要求: 连接后 5 秒内客户端须发送 `{ "type": "connect", "token": "<MANAGEMENT_BEARER_TOKEN>" }`
 * - 消息交互:
 *   - 服务端下行: ManagementFrame (connected, snapshot, changed, error)
 *   - 写操作须通过鉴权的 HTTP 接口发起，长连接只接收通知
 */
export function gatewaySocket(
  events: ConsoleSyncEvents,
  auth: GatewayAuth,
  socket: WebSocket,
  req: IncomingMessage,
) {
  let connected = false,
    closed = false,
    seq = 0;
  let unsubscribe: (() => void) | undefined;
  const send = (frame: ManagementFrame) => {
    if (closed || socket.readyState !== 1) return;
    if (socket.bufferedAmount > 1024 * 1024) {
      socket.close(1013, 'resync required');
      return;
    }
    socket.send(JSON.stringify(frame));
  };
  const fail = (error: unknown) => {
    send({ type: 'error', error: publicError(error) });
    socket.close(1008, 'management events rejected');
  };
  const timer = setTimeout(
    () => fail(new ManagementError('管理通知握手超时。', 'BAD_HANDSHAKE', 401)),
    5000,
  );
  timer.unref();
  socket.on('error', () => {});
  socket.once('close', () => {
    closed = true;
    clearTimeout(timer);
    unsubscribe?.();
  });
  socket.on('message', (data, binary) => {
    try {
      if (connected)
        throw new ManagementError(
          '此连接仅发送状态通知，请通过 HTTP 执行管理操作。',
        );
      if (
        binary ||
        Buffer.byteLength(data.toString()) > MAX_EVENT_REQUEST_BYTES
      )
        throw new ManagementError('通知握手过大或不是文本。');
      const hello = parseEventConnect(JSON.parse(data.toString()));
      if (!auth.acceptsOrigin(req.headers.origin) || !auth.verify(hello.token))
        throw new ManagementError(
          '管理员令牌或页面来源无效。',
          'UNAUTHORIZED',
          401,
        );
      connected = true;
      clearTimeout(timer);
      // Register before the refresh signal; no HTTP read can miss a subsequent change.
      unsubscribe = events.on((change) =>
        send({ type: 'event', seq: ++seq, event: 'changed', data: change }),
      );
      send({ type: 'connected', version: MANAGEMENT_EVENTS_VERSION });
      send({ type: 'event', seq: ++seq, event: 'snapshot', data: null });
    } catch (error) {
      fail(
        error instanceof SyntaxError
          ? new ManagementError('通知 JSON 无效。')
          : error,
      );
    }
  });
}

/** Registers the gateway socket on the shared Colyseus socket server. */
export function installGatewaySocket(
  routes: SocketRoutes,
  deps: { events: ConsoleSyncEvents; auth: GatewayAuth },
) {
  routes.set('/ai-characters/gateway', (socket, req) =>
    gatewaySocket(deps.events, deps.auth, socket, req),
  );
}
