import type { RequestHandler } from 'express';
import { originAllowed } from '../origin-policy';

/** Reject disallowed sources before CORS preflight or business handlers run. */
export function createOriginGuard(options: {
  origin: string;
  required?: boolean;
  message?: string;
  crossSite?: boolean;
}): RequestHandler {
  return (req, res, next) => {
    if (
      !originAllowed(
        req.headers.origin,
        options.origin,
        options.required ?? true,
      ) ||
      (options.crossSite && req.headers['sec-fetch-site'] === 'cross-site')
    ) {
      if (options.message !== undefined)
        res.status(403).json({ error: options.message });
      else res.sendStatus(403);
      return;
    }
    next();
  };
}
