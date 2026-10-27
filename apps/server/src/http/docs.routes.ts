import type { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from '../openapi/swagger';

export function installDocsRoutes(app: Express) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  /**
   * @openapi
   * /api-docs.json:
   *   get:
   *     summary: 获取 OpenAPI JSON 文档
   *     tags:
   *       - System
   *     responses:
   *       200:
   *         description: 当前服务器的 OpenAPI 3.0 文档
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [openapi, info, paths]
   *               properties:
   *                 openapi:
   *                   type: string
   *                   example: 3.0.0
   *                 info:
   *                   type: object
   *                 paths:
   *                   type: object
   */
  app.get('/api-docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(swaggerSpec);
  });
}
