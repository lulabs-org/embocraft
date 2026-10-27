import { env, type ServerConfig } from '../../config/env';
import type { Express } from 'express';

export type HealthConfig = Pick<ServerConfig, 'databaseUrl'> & {
  voice: Pick<ServerConfig['voice'], 'provider' | 'ollamaModel'>;
};

/**
 * @openapi
 * /health:
 *   get:
 *     summary: 服务器健康状态检查
 *     description: 获取服务器状态、协议版本、持久化方式与语音提供者配置
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
 *                 voice:
 *                   type: string
 *                   example: mock
 *                 voiceProviders:
 *                   type: array
 *                   items:
 *                     type: string
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
      voice: config.voice.provider,
      voiceProviders: [
        'mock',
        'browser',
        ...(config.voice.ollamaModel ? ['ollama'] : []),
      ],
    }),
  );
}
