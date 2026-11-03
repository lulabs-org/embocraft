import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RequestHandler } from 'express';
import cors from 'cors';
export type GatewayAuthConfig = {
  token?: string;
  tokenFile?: string;
  origins: string[];
  isProduction?: boolean;
};
export class GatewayAuth {
  readonly enabled: boolean;

  constructor(
    private token: string,
    readonly origins: readonly string[],
    enabled = Boolean(token),
  ) {
    this.enabled = enabled;
  }

  static async load(config: GatewayAuthConfig) {
    let token = config.token?.trim();
    if (token) {
      if (token.length < 24 || token.length > 4096 || /\s/.test(token)) {
        throw Error('管理令牌需为 24–4096 个无空白字符。');
      }
      return new GatewayAuth(token, config.origins, true);
    }

    if (config.isProduction) {
      throw Error(
        '生产环境必须配置 AGENT_GATEWAY_TOKEN 环境变量，禁止无鉴权启动 Agent Gateway。',
      );
    }

    if (config.tokenFile) {
      await mkdir(dirname(config.tokenFile), { recursive: true, mode: 0o700 });
      try {
        token = (await readFile(config.tokenFile, 'utf8')).trim();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        try {
          await writeFile(
            config.tokenFile,
            randomBytes(32).toString('base64url') + '\n',
            { mode: 0o600, flag: 'wx' },
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
        token = (await readFile(config.tokenFile, 'utf8')).trim();
      }
      if (
        !token ||
        token.length < 24 ||
        token.length > 4096 ||
        /\s/.test(token)
      ) {
        throw Error('管理令牌需为 24–4096 个无空白字符。');
      }
      return new GatewayAuth(token, config.origins, true);
    }

    // 开发环境未设置 Token：免鉴权模式
    return new GatewayAuth('', config.origins, false);
  }
  acceptsOrigin(origin: string | undefined) {
    return origin === undefined || this.origins.includes(origin);
  }
  verify(token: unknown) {
    if (!this.enabled) return true;
    if (typeof token !== 'string') return false;
    const a = Buffer.from(token),
      b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
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
      if (this.enabled) {
        if (
          !this.verify(
            req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1],
          )
        ) {
          res.status(401).json({ error: '请输入有效的管理员令牌。' });
          return;
        }
      }
      next();
    });
  };
}
