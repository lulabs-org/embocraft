import type { Express } from 'express';
import type { PiperModels } from '../services/tts/piper-models.service';
import { asyncRoute as route } from '../../../core/http/middleware/async-route';

export function installPiperRoutes(app: Express, models: PiperModels) {
  /**
   * @openapi
   * /voice/tts/piper/models:
   *   get:
   *     security:
   *       - ManagementBearer: []
   *     summary: 查询 Piper 模型目录与安装状态
   *     tags: [TTS]
   *     responses:
   *       200:
   *         description: 固定中英文模型目录，状态为 missing、installing、installed 或 failed
   *       503:
   *         description: 无法连接共享语音服务
   * /voice/tts/piper/install:
   *   post:
   *     security:
   *       - ManagementBearer: []
   *     summary: 后台安装 Piper 模型
   *     tags: [TTS]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [model]
   *             properties:
   *               model:
   *                 type: string
   *     responses:
   *       202:
   *         description: 安装已开始或复用已有任务，通过模型目录查询结果
   *       400:
   *         description: 不支持的模型
   *       409:
   *         description: 另一个模型正在安装
   */
  // Fixed catalog and server-owned downloads; never accept an upstream URL.
  app.get(
    '/voice/tts/piper/models',
    route(async (_req, res) => {
      res.json(await models.list());
    }),
  );
  app.post(
    '/voice/tts/piper/install',
    route(async (req, res) => {
      res.status(202).json(models.start(req.body?.model));
    }),
  );
}
