import { ManagementCommands } from '../../management';
import type { Express, Request } from 'express';
import type { AICharacterOrchestrator } from '../services/orchestrator.service';
import { CharacterLogService } from '../services/character-log.service';
import type {
  CharacterDetail,
  CharacterQueryPort,
} from '../persistence/queries';
import { asyncRoute as route } from '../../../core/http/middleware/async-route';

export type AICharacterRoutePort = Pick<
  AICharacterOrchestrator,
  | 'assertWritable'
  | 'create'
  | 'flush'
  | 'join'
  | 'sessionId'
  | 'remove'
  | 'setVoice'
  | 'settled'
  | 'stop'
  | 'storageRevision'
  | 'update'
> & { readonly events: Pick<AICharacterOrchestrator['events'], 'version'> };

/**
 * 安装 AI 角色基础配置与生命周期控制相关 HTTP REST 路由
 */
export function installAICharacterRoutes(
  app: Express,
  manager: AICharacterRoutePort,
  commands: ManagementCommands,
  queries: CharacterQueryPort,
  logService: CharacterLogService = new CharacterLogService(queries),
) {
  const { events } = manager;
  const response = (character: CharacterDetail, resourceVersion: number) => ({
    ...character,
    sessionId: manager.sessionId(character.id),
    resourceVersion,
  });

  const write = (req: Request, action: () => unknown | Promise<unknown>) =>
    commands.execute(
      req,
      req.method === 'DELETE' ? 'plans' : String(req.params.id ?? 'registry'),
      async () => {
        manager.assertWritable(
          ['stop'].includes(String(req.path.split('/').at(-1))) ||
            req.method === 'DELETE'
            ? undefined
            : req.params.id,
        );
        const since = manager.storageRevision;
        const result = await action();
        await manager.flush(since);
        if (!result || typeof result !== 'object' || !('id' in result))
          return result;
        const version = events.version;
        return response(await queries.get(String(result.id)), version);
      },
    );

  // ---------------------------------------------------------------------------
  // AI 角色基础与生命周期
  // ---------------------------------------------------------------------------

  /**
   * @openapi
   * /ai-characters:
   *   get:
   *     security:
   *       - ManagementBearer: []
   *     summary: 获取所有 AI 角色列表
   *     tags:
   *       - AI Characters
   *     responses:
   *       200:
   *         description: AI 角色列表
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/AICharacterView'
   */
  app.get(
    '/ai-characters',
    route(async (_req, res) => {
      const version = events.version;
      res.json(
        (await queries.list()).map((character) => response(character, version)),
      );
    }),
  );

  /**
   * @openapi
   * /ai-characters/{id}:
   *   get:
   *     security:
   *       - ManagementBearer: []
   *     summary: 获取指定 AI 角色详情
   *     tags:
   *       - AI Characters
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: AI 角色详情
   *       404:
   *         description: AI 角色不存在
   */
  app.get(
    '/ai-characters/:id',
    route(async (req, res) => {
      // Capture before the async read: a concurrent commit must not be stamped as seen.
      const version = events.version;
      const character = await queries.get(String(req.params.id));
      res.json(response(character, version));
    }),
  );

  /**
   * @openapi
   * /ai-characters/{id}/logs:
   *   get:
   *     security:
   *       - ManagementBearer: []
   *     summary: 分页获取指定 AI 角色的运行日志（最新在前）
   *     tags:
   *       - AI Characters
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: limit
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 200
   *           default: 50
   *       - in: query
   *         name: cursor
   *         required: false
   *         description: 上一页返回的 nextCursor；省略时从最新日志开始
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: 日志分页
   *       404:
   *         description: AI 角色不存在
   */
  app.get(
    '/ai-characters/:id/logs',
    route(async (req, res) => {
      const body = await logService.getLogsPage(String(req.params.id), {
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      res.json(body);
    }),
  );

  /**
   * @openapi
   * /ai-characters:
   *   post:
   *     security:
   *       - ManagementBearer: []
   *     summary: 创建 AI 角色（默认上线待命）
   *     description: 只保存 AI 角色配置并按 joinWorld 上线，不创建任务计划、执行记录或自动调用模型。任务请通过 Tasks 创建。
   *     tags:
   *       - AI Characters
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/AICharacterCreate'
   *     responses:
   *       201:
   *         description: AI 角色创建成功（上线待命或离线），无任务执行
   *       400:
   *         description: 参数无效或包含任务参数，请使用 Tasks
   */
  app.post(
    '/ai-characters',
    route(async (req, res) => {
      const result = await write(req, () => manager.create(req.body));
      res.status(201).json(result);
    }),
  );

  /**
   * @openapi
   * /ai-characters/{id}:
   *   put:
   *     security:
   *       - ManagementBearer: []
   *     summary: 更新 AI 角色配置
   *     description: 不创建或替换任务，不修改任务目标；startTask、taskTimeZone 或 goal 返回 400，请使用 Tasks。
   *     tags:
   *       - AI Characters
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
   *             $ref: '#/components/schemas/AICharacterProfileUpdate'
   *     responses:
   *       200:
   *         description: AI 角色配置更新成功，已有任务进度保留
   *       400:
   *         description: 参数无效或包含任务参数，请使用 Tasks
   */
  app.put(
    '/ai-characters/:id',
    route(async (req, res) => {
      const result = await write(req, () =>
        manager.update(String(req.params.id), req.body),
      );
      res.json(result);
    }),
  );

  /**
   * @openapi
   * /ai-characters/{id}:
   *   delete:
   *     security:
   *       - ManagementBearer: []
   *     summary: 停止并删除 AI 角色，保留任务计划、运行历史、世界建筑和共享服务
   *     tags: [AI Characters]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       204:
   *         description: 删除已持久化
   *       404:
   *         description: AI 角色不存在
   *       409:
   *         description: AI 角色正在更新
   */
  app.delete(
    '/ai-characters/:id',
    route(async (req, res) => {
      await write(req, () => manager.remove(String(req.params.id)));
      res.sendStatus(204);
    }),
  );

  /**
   * @openapi
   * /ai-characters/{id}/join:
   *   post:
   *     security:
   *       - ManagementBearer: []
   *     summary: 让 AI 角色加入游戏世界房间
   *     tags:
   *       - AI Characters
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: 加入成功
   */
  app.post(
    '/ai-characters/:id/join',
    route(async (req, res) => {
      const id = String(req.params.id);
      const result = await write(req, async () => {
        const value = manager.join(id);
        await manager.settled(id);
        return value;
      });
      res.json(result);
    }),
  );

  /**
   * @openapi
   * /ai-characters/{id}/stop:
   *   post:
   *     security:
   *       - ManagementBearer: []
   *     summary: 停止 AI 角色并移出世界
   *     tags:
   *       - AI Characters
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: 停止成功
   */
  app.post(
    '/ai-characters/:id/stop',
    route(async (req, res) => {
      const id = String(req.params.id);
      const result = await write(req, async () => {
        const value = manager.stop(id);
        await manager.settled(id);
        return value;
      });
      res.json(result);
    }),
  );

  /**
   * @openapi
   * /ai-characters/{id}/voice:
   *   post:
   *     security:
   *       - ManagementBearer: []
   *     summary: 配置 AI 角色音色与发音服务
   *     tags:
   *       - AI Characters
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
   *         description: 音色设置成功
   */
  app.post(
    '/ai-characters/:id/voice',
    route(async (req, res) => {
      const result = await write(req, () =>
        manager.setVoice(String(req.params.id), req.body),
      );
      res.json(result);
    }),
  );
}
