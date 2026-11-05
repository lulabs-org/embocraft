import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import cors from 'cors';
import type { ServerConfig } from '../../core/config';

export class GatewayAuth {
  constructor(private readonly config: ServerConfig['gateway']) {}

  acceptsOrigin(origin: string | undefined) {
    return origin === undefined || this.config.origins.includes(origin);
  }
  verify(token: unknown) {
    if (!this.config.token) return true;
    if (typeof token !== 'string') return false;
    const actual = Buffer.from(token);
    const expected = Buffer.from(this.config.token);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
  private cors = cors({
    origin: true,
    methods: 'GET, POST, PUT, DELETE, OPTIONS',
    allowedHeaders: 'Content-Type, Authorization, Idempotency-Key',
  });
  middleware: RequestHandler = (req, res, next) => {
    const origin = req.headers.origin;
    if (!this.acceptsOrigin(origin)) {
      res.status(403).json({ error: '不允许此页面管理 Agent。' });
      return;
    }
    res.header('Cache-Control', 'no-store');
    this.cors(req, res, (error) => {
      if (error) return next(error);
      const token = req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
      if (!this.verify(token)) {
        res.status(401).json({ error: '请输入有效的管理员令牌。' });
        return;
      }
      next();
    });
  };
}
