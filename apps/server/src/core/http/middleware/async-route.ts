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

/**
 * Execute an async route with an AbortSignal tied to the client connection lifecycle.
 * If the client disconnects before the response completes, the signal is aborted.
 * Errors thrown after abort are suppressed to prevent writing to closed responses.
 */
export function asyncAbortableRoute(
  fn: (req: Request, res: Response, signal: AbortSignal) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', cancel);
    Promise.resolve()
      .then(() => fn(req, res, controller.signal))
      .catch((error) => {
        if (!controller.signal.aborted) next(error);
      })
      .finally(() => {
        res.off('close', cancel);
      });
  };
}

