import cors from 'cors';
import type { RequestHandler } from 'express';
import { originAllowed } from './origin-policy';

/** Routes own preflight responses after their access checks. */
export function publicCors(origin: string): RequestHandler {
  const headers = cors({
    origin: (requestOrigin, callback) =>
      callback(
        null,
        !!requestOrigin && originAllowed(requestOrigin, origin, false),
      ),
  });
  return (req, res, next) => {
    if (req.method === 'OPTIONS') next();
    else headers(req, res, next);
  };
}
