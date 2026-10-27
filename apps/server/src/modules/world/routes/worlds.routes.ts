import cors from 'cors';
import { env } from '../../../core/config/env';
import { createOriginGuard } from '../../../core/http/middleware/origin-guard';
import type { Express } from 'express';
import type { WorldPresence } from '@voxel/shared';

/**
 * @openapi
 * /world:
 *   get:
 *     summary: 获取当前世界房间 ID
 *     description: 获取 Colyseus 当前活动的 WorldRoom 实例房间 ID
 *     tags:
 *       - World
 *     responses:
 *       200:
 *         description: 返回世界房间信息
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 roomId:
 *                   type: string
 *                   example: 4xK9pL2
 */
export function installWorldRoutes(app: Express, getRoomId: () => string) {
  app.get('/world', (_req, res) => res.json({ roomId: getRoomId() }));
}

/** Read-only world presence. Viewing the lobby never reserves a player seat. */
export function installPresenceRoutes(
  app: Express,
  read: () => WorldPresence | undefined,
  allowed = env.webOrigin(),
) {
  /**
   * @openapi
   * /world/presence:
   *   get:
   *     summary: 世界状态 SSE 长连接
   *     description: 监听世界的在线玩家与在线状态 (Server-Sent Events)
   *     tags:
   *       - World
   *     responses:
   *       200:
   *         description: 实时 SSE 事件流
   *         content:
   *           text/event-stream:
   *             schema:
   *               type: string
   *       403:
   *         description: Origin 不受信任
   *       503:
   *         description: 世界服务未就绪
   */
  app.get(
    '/world/presence',
    createOriginGuard({ origin: allowed, required: false }),
    cors({ origin: true }),
    (_req, res) => {
      if (!read()) {
        res.sendStatus(503);
        return;
      }
      res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      const send = () => {
        const state = read();
        if (!state) {
          res.end();
          return;
        }
        // A heartbeat on every tick also detects loss of the world service.
        if (!res.writableNeedDrain)
          res.write(`data: ${JSON.stringify(state)}\n\n`);
      };
      const interval = setInterval(send, 1000);
      res.on('close', () => clearInterval(interval));
      send();
    },
  );
}
