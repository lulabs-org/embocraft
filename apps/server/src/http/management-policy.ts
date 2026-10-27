import { publicError } from '../modules/management/errors';
import express, { type Express, type RequestHandler } from 'express';
import { identifier } from '../core/http/validation';
import { AppError } from '../core/errors/app-error';
import { requireJsonRequest } from '../core/http/middleware/require-json';
import { errorHandler } from '../core/http/middleware/error-handler';

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

/** Full policy for the existing 32 KiB management APIs; ASR has its own contract. */
export function installManagementJsonRoutes(
  app: Express,
  paths: string | string[],
  authenticate: RequestHandler,
  install: () => void,
) {
  app.use(paths, authenticate, ...managementBody);
  // Register on the app itself so command fingerprints retain the full req.path.
  install();
  app.use(paths, (_req, res) => {
    res.status(404).json({ error: '管理接口不存在，请确认前后端版本一致。' });
  });
  app.use(paths, managementErrors);
}
