import { env, type ServerConfig } from '../../config/env';
import type { Express } from 'express';

export type HealthConfig = Pick<ServerConfig, 'databaseUrl'>;

/**
 * @openapi
 * /health:
 *   get:
 *     summary: 服务器健康状态检查
 *     description: 获取服务器状态、协议版本与持久化方式
 *     tags:
 *       - System
 *     responses:
 *       200:
 *         description: 成功返回系统健康信息
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 protocol:
 *                   type: integer
 *                   example: 1
 *                 persistence:
 *                   type: string
 *                   example: memory
 */
export function installHealthRoutes(
  app: Express,
  config: HealthConfig = env.readServer(),
) {
  app.get('/health', (_req, res) =>
    res.json({
      ok: true,
      protocol: 1,
      persistence: config.databaseUrl ? 'postgresql' : 'memory',
    }),
  );
}
