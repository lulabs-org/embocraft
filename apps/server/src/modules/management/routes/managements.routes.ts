import type { Express } from 'express';
import { identifier } from '../../../core/http/validation';
import type { ManagementCommands } from '../services/commands.service';

export function installManagementRoutes(
  app: Express,
  commands: ManagementCommands,
) {
  /**
   * @openapi
   * /management/commands/{id}:
   *   get:
   *     security:
   *       - ManagementBearer: []
   *     summary: 查询管理命令回执
   *     description: 根据写入请求使用的 Idempotency-Key 或服务器生成的命令 ID 查询执行状态；过期或不存在的命令返回 unknown。
   *     tags:
   *       - Management
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         description: 命令 ID
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: 命令当前回执
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [state]
   *               properties:
   *                 state:
   *                   type: string
   *                   enum: [pending, committed, rejected, unknown]
   *                 result:
   *                   description: 已提交命令的返回值，仅 committed 时可能存在
   *                 error:
   *                   type: object
   *                   description: 被拒绝命令的错误，仅 rejected 时可能存在
   *                   required: [code, message, status]
   *                   properties:
   *                     code:
   *                       type: string
   *                     message:
   *                       type: string
   *                     status:
   *                       type: integer
   *       400:
   *         $ref: '#/components/responses/Management400'
   *       401:
   *         $ref: '#/components/responses/Management401'
   *       403:
   *         $ref: '#/components/responses/Management403'
   */
  app.get('/management/commands/:id', (req, res) => {
    if (!identifier(req.params.id)) {
      res.status(400).json({ error: '命令标识无效。' });
      return;
    }
    res.json(commands.get(req.params.id));
  });
}
