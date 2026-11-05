import { consoleSync } from '../../console-sync';
import express, { type Router } from 'express';
import { providerService } from '../services/provider.service';
import { asyncRoute as route } from '../../../core/http/middleware/async-route';

/** 创建独立的 Provider 路由 Router 实例 */
export function createProviderRouter(): Router {
  const router = express.Router();
  /**
   * @openapi
   * /providers:
   *   get:
   *     security:
   *       - ManagementBearer: []
   *     summary: 获取 LLM 模型提供商配置列表
   *     tags:
   *       - Providers
   *     responses:
   *       200:
   *         description: 提供商配置列表
   */
  router.get(
    '/providers',
    route(async (_req, res) => {
      res.json(await providerService.list());
    }),
  );

  /**
   * @openapi
   * /providers:
   *   post:
   *     security:
   *       - ManagementBearer: []
   *     summary: 添加 LLM 模型提供商配置
   *     tags:
   *       - Providers
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
    '/providers',
    route(async (req, res) => {
      const result = await consoleSync.execute(req, 'providers', () =>
        providerService.save(req.body),
      );
      res.status(201).json(result);
    }),
  );

  /**
   * @openapi
   * /providers/{id}:
   *   put:
   *     security:
   *       - ManagementBearer: []
   *     summary: 更新 LLM 模型提供商配置
   *     tags:
   *       - Providers
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
    '/providers/:id',
    route(async (req, res) => {
      const result = await consoleSync.execute(req, 'providers', () =>
        providerService.save(req.body, String(req.params.id)),
      );
      res.json(result);
    }),
  );

  /**
   * @openapi
   * /providers/{id}:
   *   delete:
   *     security:
   *       - ManagementBearer: []
   *     summary: 删除 LLM 模型提供商配置
   *     tags:
   *       - Providers
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
    '/providers/:id',
    route(async (req, res) => {
      await consoleSync.execute(req, 'providers', () =>
        providerService.remove(String(req.params.id)),
      );
      res.sendStatus(204);
    }),
  );

  /**
   * @openapi
   * /providers/{id}/models:
   *   get:
   *     security:
   *       - ManagementBearer: []
   *     summary: 获取指定提供商下的可用模型列表
   *     tags:
   *       - Providers
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: 可用模型列表
   */
  router.get(
    '/providers/:id/models',
    route(async (req, res) => {
      const models = await providerService.models(String(req.params.id));
      res.json({ models });
    }),
  );

  /**
   * @openapi
   * /providers/{id}/health:
   *   get:
   *     security:
   *       - ManagementBearer: []
   *     summary: 探测模型服务连通性与模型列表能力
   *     tags:
   *       - Providers
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: 连通性与模型列表能力
   */
  router.get(
    '/providers/:id/health',
    route(async (req, res) => {
      res.json(await providerService.health(String(req.params.id)));
    }),
  );
  return router;
}
