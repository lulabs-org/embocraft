import cors from 'cors';
import { env } from '../../../core/config/env';
import { createOriginGuard } from '../../../core/http/middleware/origin-guard';
import { asyncRoute } from '../../../core/http/middleware/async-route';
import { assertJsonRequest } from '../../../core/http/middleware/require-json';
import { errorHandler } from '../../../core/http/middleware/error-handler';
import express, { type Express, type Request, type Response } from 'express';
import { AsrSettingsStore } from '../asr/asr-settings';
import { AppError } from '../../../core/errors/app-error';

export function installAsrRoutes(
  app: Express,
  store: AsrSettingsStore,
  origin = env.webOrigin(),
  authenticatedManagement = false,
) {
  const pageAccess = express.Router();
  pageAccess.use(
    createOriginGuard({
      origin,
      message: '仅允许配置的游戏页面管理语音识别。',
    }),
    (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
    cors({
      origin: true,
      allowedHeaders: 'Content-Type',
      methods: 'GET, POST, PUT, DELETE, OPTIONS',
    }),
  );
  app.use('/voice/asr', (req, res, next) => {
    if (
      authenticatedManagement &&
      (req.path === '/services' || req.path.startsWith('/services/'))
    )
      next();
    else pageAccess(req, res, next);
  });
  app.use('/voice/asr', express.json({ limit: '8kb' }));
  const route = (fn: (req: Request, res: Response) => unknown) =>
    asyncRoute((req, res) => {
      try {
        assertJsonRequest(req);
      } catch {
        throw new AppError('请使用 JSON 请求。', 415);
      }
      return fn(req, res);
    });
  /**
   * @openapi
   * /voice/asr/services:
   *   get:
   *     security:
   *       - ManagementBearer: []
   *     summary: 获取 ASR 语音识别服务配置列表
   *     tags:
   *       - ASR
   *     responses:
   *       200:
   *         description: ASR 服务配置列表
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   */
  app.get('/voice/asr/services', (_req, res) => res.json(store.list()));

  /**
   * @openapi
   * /voice/asr/services:
   *   post:
   *     security:
   *       - ManagementBearer: []
   *     summary: 添加新的 ASR 语音识别服务配置
   *     tags:
   *       - ASR
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       201:
   *         description: 创建成功
   *       400:
   *         description: 配置参数错误
   *       415:
   *         description: 请求非 JSON 格式
   */
  app.post(
    '/voice/asr/services',
    route(async (req, res) => res.status(201).json(await store.save(req.body))),
  );

  /**
   * @openapi
   * /voice/asr/services/{id}:
   *   put:
   *     security:
   *       - ManagementBearer: []
   *     summary: 更新 ASR 语音识别服务配置
   *     tags:
   *       - ASR
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: ASR 服务 ID
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       200:
   *         description: 更新成功
   *       400:
   *         description: 配置格式错误
   */
  app.put(
    '/voice/asr/services/:id',
    route(async (req, res) =>
      res.json(await store.save(req.body, String(req.params.id))),
    ),
  );

  /**
   * @openapi
   * /voice/asr/services/{id}:
   *   delete:
   *     security:
   *       - ManagementBearer: []
   *     summary: 删除 ASR 语音识别服务配置
   *     tags:
   *       - ASR
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: ASR 服务 ID
   *     responses:
   *       204:
   *         description: 删除成功
   */
  app.delete(
    '/voice/asr/services/:id',
    route(async (req, res) => {
      await store.remove(String(req.params.id));
      res.sendStatus(204);
    }),
  );
  app.use(
    '/voice/asr',
    errorHandler((error) => {
      const type =
        error && typeof error === 'object' && 'type' in error
          ? error.type
          : undefined;
      return {
        status:
          error instanceof AppError
            ? error.status
            : type === 'entity.too.large'
              ? 413
              : type === 'entity.parse.failed'
                ? 400
                : 500,
        body: {
          error:
            error instanceof AppError
              ? error.message
              : type
                ? '识别配置须为有效 JSON，且不超过 8 KiB。'
                : '识别服务操作失败，请重试。',
        },
      };
    }),
  );
}
