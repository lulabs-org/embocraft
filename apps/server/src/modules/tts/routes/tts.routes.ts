import express, { type Router } from 'express';
import { ttsService } from '../composition';
import { env } from '../../../core/config/env';
import {
  asyncAbortableRoute,
  asyncRoute as route,
} from '../../../core/http/middleware/async-route';

/** 创建独立的 TTS 路由 Router 实例 */
export function createTtsRouter(): Router {
  const router = express.Router();

  /**
   * @openapi
   * /voice/tts/defaults:
   *   get:
   *     security:
   *       - ManagementBearer: []
   *     summary: 获取当前部署的 Speaches 默认接口地址
   *     tags:
   *       - TTS
   *     responses:
   *       200:
   *         description: Speaches 默认连接配置
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 baseUrl:
   *                   type: string
   */
  router.get(
    '/voice/tts/defaults',
    route((_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ baseUrl: env.speechEndpoint() });
    }),
  );

  /**
   * @openapi
   * /voice/tts/models:
   *   post:
   *     security:
   *       - ManagementBearer: []
   *     summary: 查询当前 Speaches 连接中的已安装模型与音色，不保存配置
   *     tags:
   *       - TTS
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               baseUrl:
   *                 type: string
   *               apiKey:
   *                 type: string
   *               serviceId:
   *                 type: string
   *                 description: 连接地址未变化时，可复用已保存的密钥
   *     responses:
   *       200:
   *         description: 当前服务的 TTS 模型及音色列表
   */
  router.post(
    '/voice/tts/models',
    asyncAbortableRoute(async (req, res, signal) => {
      res.setHeader('Cache-Control', 'no-store');
      const models = await ttsService.models(req.body, signal);
      if (!signal.aborted) res.json({ models });
    }),
  );

  /**
   * @openapi
   * /voice/tts/services:
   *   get:
   *     security:
   *       - ManagementBearer: []
   *     summary: 获取语音合成服务配置列表
   *     tags:
   *       - TTS
   *     responses:
   *       200:
   *         description: 语音服务配置列表
   */
  router.get(
    '/voice/tts/services',
    route(async (_req, res) => res.json(await ttsService.list())),
  );

  /**
   * @openapi
   * /voice/tts/services:
   *   post:
   *     security:
   *       - ManagementBearer: []
   *     summary: 添加新的语音合成服务配置
   *     tags:
   *       - TTS
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       201:
   *         description: 创建成功
   */
  router.post(
    '/voice/tts/services',
    route(async (req, res) =>
      res.status(201).json(await ttsService.save(req.body)),
    ),
  );

  /**
   * @openapi
   * /voice/tts/services/{id}:
   *   put:
   *     security:
   *       - ManagementBearer: []
   *     summary: 更新语音合成服务配置
   *     tags:
   *       - TTS
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       200:
   *         description: 更新成功
   */
  router.put(
    '/voice/tts/services/:id',
    route(async (req, res) =>
      res.json(await ttsService.save(req.body, String(req.params.id))),
    ),
  );

  /**
   * @openapi
   * /voice/tts/services/{id}:
   *   delete:
   *     security:
   *       - ManagementBearer: []
   *     summary: 删除语音合成服务配置
   *     tags:
   *       - TTS
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       204:
   *         description: 删除成功
   */
  router.delete(
    '/voice/tts/services/:id',
    route(async (req, res) => {
      await ttsService.remove(String(req.params.id));
      res.sendStatus(204);
    }),
  );

  /**
   * @openapi
   * /voice/tts/services/{id}/preview:
   *   post:
   *     security:
   *       - ManagementBearer: []
   *     summary: 试听语音合成效果
   *     tags:
   *       - TTS
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               text:
   *                 type: string
   *                 example: "你好，我是智能体。"
   *     responses:
   *       200:
   *         description: 合成的 WAV 音频
   *         content:
   *           audio/wav:
   *             schema:
   *               type: string
   *               format: binary
   */
  router.post(
    '/voice/tts/services/:id/preview',
    route(async (req, res) => {
      const abort = new AbortController();
      const cancel = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.on('close', cancel);
      try {
        const audio = await ttsService.synthesize(
          String(req.params.id),
          req.body?.text,
          abort.signal,
        );
        if (!abort.signal.aborted) res.type('audio/wav').send(audio.bytes);
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      } finally {
        res.off('close', cancel);
      }
    }),
  );

  return router;
}
