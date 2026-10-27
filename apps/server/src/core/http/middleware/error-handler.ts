import type { ErrorRequestHandler } from 'express';
import { AppError } from '../../errors/app-error';
export type ErrorResponse = {
  status: number;
  body: { error: string; code?: string };
};

/** Only log error categories and source locations, never messages or request data. */
function logServerError(error: unknown, status: number) {
  const kind =
    error instanceof Error
      ? ([TypeError, SyntaxError, RangeError, ReferenceError, URIError].find(
          (type) => error instanceof type,
        )?.name ?? 'Error')
      : 'NonError';
  const locations =
    error instanceof Error && typeof error.stack === 'string'
      ? error.stack
          .split('\n')
          .filter((line) => /^\s+at /.test(line))
          .flatMap((line) => {
            const location = line.match(
              /\/(apps|packages|scripts)\/([\w./-]+\.[cm]?[jt]sx?:\d+:\d+)\)?$/,
            );
            return location ? [`${location[1]}/${location[2]}`] : [];
          })
      : [];
  console.error('[http] Request failed', { status, kind, locations });
}

/** Domain formatters preserve existing HTTP contracts; streaming failures delegate after headers. */
export function errorHandler(
  format: (error: unknown) => ErrorResponse = (error) => ({
    status: error instanceof AppError ? error.status : 500,
    body: {
      error:
        error instanceof AppError
          ? error.message
          : '无法处理请求，请稍后重试。',
    },
  }),
): ErrorRequestHandler {
  return (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const response = format(error);
    if (response.status >= 500) logServerError(error, response.status);
    res.status(response.status).json(response.body);
  };
}
