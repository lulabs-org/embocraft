import type { RequestHandler, Request } from 'express';
import { AppError } from '../../errors/app-error';
export function assertJsonRequest(req: Request) {
  if (['POST', 'PUT'].includes(req.method) && !req.is('application/json'))
    throw new AppError('请使用 JSON 请求。', 415);
}
export const requireJsonRequest: RequestHandler = (req, _res, next) => {
  assertJsonRequest(req);
  next();
};
