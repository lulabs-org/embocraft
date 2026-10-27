import type { Request, Response, RequestHandler, NextFunction } from 'express';
/** Forward async rejections and synchronous throws through the same error middleware. */
export function asyncRoute(
  fn: (req: Request, res: Response, next: NextFunction) => unknown,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch(next);
  };
}
