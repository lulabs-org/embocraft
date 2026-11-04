import express, { type RequestHandler, type Router } from 'express';
import { identifier } from '../validation';
import { AppError } from '../../errors/app-error';
import { publicError } from '../../errors/public-error';
import { requireJsonRequest } from './require-json';
import { errorHandler } from './error-handler';

const validateIdempotencyKey: RequestHandler = (req, res, next) => {
  const key = req.header('Idempotency-Key');
  if (key !== undefined && !identifier(key)) {
    res.status(400).json({ error: 'Idempotency-Key 无效。' });
    return;
  }
  next();
};

/** 默认受控控制台管理路由前缀 */
export const DEFAULT_MANAGEMENT_PATHS = [
  '/ai-characters',
  '/providers',
  '/tasks',
  '/task-runs',
  '/console-sync',
] as const;

/** Shared management transport policy; authentication is supplied by composition. */
export const managementBody = [
  validateIdempotencyKey,
  requireJsonRequest,
  express.json({ limit: '32kb' }),
];

export const managementErrors = errorHandler((error) => {
  if (error instanceof AppError)
    return { status: error.status, body: { error: error.message } };
  if (
    error &&
    typeof error === 'object' &&
    'type' in error &&
    (error.type === 'entity.too.large' || error.type === 'entity.parse.failed')
  )
    return {
      status: error.type === 'entity.too.large' ? 413 : 400,
      body: { error: '无法处理请求，请检查输入或本机配置文件权限。' },
    };
  const e = publicError(error);
  return { status: e.status, body: { error: e.message } };
});

/**
 * 构造管理接口专属 Router：
 * 1. 挂载身份鉴权与 32 KiB JSON 限制等前置中间件
 * 2. 由 install 回调注册具体的管理领域路由
 * 3. 挂载未命中 404 及统一管理异常处理中间件
 */
export function createManagementRouter(
  paths: string | readonly string[],
  authenticate: RequestHandler,
  install: (router: Router) => void,
): Router {
  const router = express.Router();
  const routePaths = paths as string | string[];
  router.use(routePaths, authenticate, ...managementBody);
  install(router);
  router.use(routePaths, (_req, res) => {
    res.status(404).json({ error: '管理接口不存在，请确认前后端版本一致。' });
  });
  router.use(routePaths, managementErrors);
  return router;
}

/**
 * @deprecated 建议改用 createManagementRouter 或 installManagementJsonRoutes
 */
export class ManagementScope {
  private readonly routePaths: string | string[];

  constructor(
    private readonly app: Router,
    private readonly paths: string | readonly string[],
    authenticate: RequestHandler,
  ) {
    this.routePaths = paths as string | string[];
    app.use(this.routePaths, authenticate, ...managementBody);
  }

  close() {
    this.app.use(this.routePaths, (_req, res) => {
      res.status(404).json({ error: '管理接口不存在，请确认前后端版本一致。' });
    });
    this.app.use(this.routePaths, managementErrors);
  }
}

/** Full policy for the existing 32 KiB management APIs; ASR has its own contract. */
export function installManagementJsonRoutes(
  router: Router,
  paths: string | readonly string[],
  authenticate: RequestHandler,
  install: (router: Router) => void,
) {
  router.use(createManagementRouter(paths, authenticate, install));
}
