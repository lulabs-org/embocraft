import express, { type Express, type RequestHandler } from 'express';
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
 * 线性声明管理接口切面的作用域生命周期：
 * 1. 构造时挂载身份鉴权与 32 KiB JSON 限制中间件
 * 2. 期间由调用方线性注册各个管理领域路由
 * 3. close() 挂载未命中 404 及统一管理异常处理中间件
 */
export class ManagementScope {
  constructor(
    private readonly app: Express,
    private readonly paths: string | string[],
    authenticate: RequestHandler,
  ) {
    app.use(paths, authenticate, ...managementBody);
  }

  close() {
    this.app.use(this.paths, (_req, res) => {
      res.status(404).json({ error: '管理接口不存在，请确认前后端版本一致。' });
    });
    this.app.use(this.paths, managementErrors);
  }
}

/** Full policy for the existing 32 KiB management APIs; ASR has its own contract. */
export function installManagementJsonRoutes(
  app: Express,
  paths: string | string[],
  authenticate: RequestHandler,
  install: () => void,
) {
  const scope = new ManagementScope(app, paths, authenticate);
  install();
  scope.close();
}

