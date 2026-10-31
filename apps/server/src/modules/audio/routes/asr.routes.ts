import cors from 'cors';
import { env } from '../../../core/config/env';
import { createOriginGuard } from '../../../core/http/middleware/origin-guard';
import {
  asyncAbortableRoute,
  asyncRoute,
} from '../../../core/http/middleware/async-route';
import { assertJsonRequest } from '../../../core/http/middleware/require-json';
import { errorHandler } from '../../../core/http/middleware/error-handler';
import express, { type Express, type Request, type Response } from 'express';
import { AsrSettingsStore } from '../persistence/asr-settings-store';
import { AppError } from '../../../core/errors/app-error';
import { speechEndpoint } from '../speech-endpoint';

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
  const assignmentRead = [
    createOriginGuard({ origin, required: false, crossSite: true }),
    cors({ origin: true, methods: 'GET' }),
  ];
  /**
   * @openapi
   * /voice/asr/assignments:
   *   get:
   *     summary: 获取游戏使用的识别服务分配（仅 ID、名称、类型）
   *     tags: [ASR]
   *     responses:
   *       200:
   *         description: 附近语音、语音输入和语音消息转文字的服务分配
   */
  app.get('/voice/asr/assignments', ...assignmentRead, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(store.assignments());
  });
  app.use('/voice/asr', (req, res, next) => {
    if (
      authenticatedManagement &&
      (req.path === '/services' ||
        req.path === '/defaults' ||
        req.path === '/models' ||
        req.path.startsWith('/services/') ||
        req.path.startsWith('/assignments/'))
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
   * /voice/asr/defaults:
   *   get:
   *     security:
   *       - ManagementBearer: []
   *     summary: 获取当前部署的 Speaches 默认识别接口地址
   *     tags: [ASR]
   *     responses:
   *       200:
   *         description: 默认识别服务连接配置
   */
  app.get('/voice/asr/defaults', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ baseUrl: speechEndpoint() });
  });
  /**
   * @openapi
   * /voice/asr/models:
   *   post:
   *     security:
   *       - ManagementBearer: []
   *     summary: 查询当前 Speaches 连接中的已安装识别模型，不保存配置
   *     tags: [ASR]
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
   *                 description: 地址未变化时用于复用已保存的密钥
   *     responses:
   *       200:
   *         description: 已安装的 ASR 模型列表
   */
  app.post(
    '/voice/asr/models',
    asyncAbortableRoute(async (req, res, signal) => {
      assertJsonRequest(req);
      res.setHeader('Cache-Control', 'no-store');
      const models = await store.models(req.body, signal);
      if (!signal.aborted) res.json({ models });
    }),
  );
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
   * /voice/asr/assignments/{use}:
   *   put:
   *     security:
   *       - ManagementBearer: []
   *     summary: 保存全局识别服务分配
   *     tags: [ASR]
   *     parameters:
   *       - in: path
   *         name: use
   *         required: true
   *         schema:
   *           type: string
   *           enum: [chat, spatial, clip]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [serviceId]
   *             properties:
   *               serviceId:
   *                 type: string
   *     responses:
   *       200:
   *         description: 更新后的三个功能的服务分配
   */
  app.put(
    '/voice/asr/assignments/:use',
    route(async (req, res) => {
      res.json(await store.assign(req.params.use, req.body?.serviceId));
    }),
  );

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
