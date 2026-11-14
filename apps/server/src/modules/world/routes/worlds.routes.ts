import cors from 'cors';
import express, { type Router } from 'express';
import { env } from '../../../core/config/env';
import { createOriginGuard } from '../../../core/http/middleware/origin-guard';
import type { WorldPresence } from '@voxel/shared';

export type WorldRoutePort = {
  roomId: string;
  getPresence(): WorldPresence | undefined;
};

/** 创建独立的世界路由 Router 实例 */
export function createWorldRouter(
  getWorld: () => WorldRoutePort | undefined,
): Router {
  const router = express.Router();
  const allowed = env.webOrigin();

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
  router.get('/world', (_req, res) =>
    res.json({ roomId: getWorld()?.roomId ?? '' }),
  );

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
  router.get(
    '/world/presence',
    createOriginGuard({ origin: allowed, required: false }),
    cors({ origin: true }),
    (_req, res) => {
      const read = () => getWorld()?.getPresence();
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

  return router;
}
