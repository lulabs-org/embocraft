import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express, { type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { AppError } from '../src/common/errors';
import { asyncRoute } from '../src/http/middleware/async-route';
import { errorHandler } from '../src/http/middleware/error-handler';
import {
  managementBody,
  managementErrors,
} from '../src/http/management-policy';

let server: Server;
let url: string;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const app = express();
  app.use('/management', ...managementBody);
  app.all('/management/echo', (req, res) => res.json(req.body ?? {}));
  app.get(
    '/management/internal',
    asyncRoute(async () => {
      JSON.parse('upstream-secret');
    }),
  );
  app.use('/management', managementErrors);
  app.get(
    '/default/internal',
    asyncRoute(() => {
      const error = new TypeError('apiKey=secret-message');
      error.stack = [
        'TypeError: apiKey=secret-message',
        'message continuation with secret',
        '    at fetch (https://upstream.test/?token=secret-url:1:2)',
        '    at secretFunction (/workspace/apps/server/src/example.ts:12:3)',
        '    at /workspace/packages/shared/src/example.ts:20:4',
      ].join('\n');
      throw error;
    }),
  );
  app.get(
    '/default/expected',
    asyncRoute(() => {
      throw new AppError('公开错误', 409, 'existing-code');
    }),
  );
  app.get(
    '/default/unavailable',
    asyncRoute(() => {
      throw new AppError('服务暂不可用', 503);
    }),
  );
  app.use(errorHandler());
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.restoreAllMocks();
});

it.each(['POST', 'PUT'])(
  'preserves the %s JSON and media-type contracts',
  async (method) => {
    const valid = await fetch(`${url}/management/echo`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: '{"value":1}',
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ value: 1 });
    const invalid = await fetch(`${url}/management/echo`, {
      method,
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(invalid.status).toBe(415);
    expect(await invalid.json()).toEqual({ error: '请使用 JSON 请求。' });
    expect(log).not.toHaveBeenCalled();
  },
);

it.each(['GET', 'DELETE'])(
  'does not require JSON for %s without a body',
  async (method) => {
    const response = await fetch(`${url}/management/echo`, { method });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  },
);

it.each([
  ['malformed', '{"apiKey":"secret-body",', 400],
  ['oversized', JSON.stringify({ value: 'x'.repeat(33000) }), 413],
])('preserves the %s JSON error contract', async (_name, body, status) => {
  const response = await fetch(`${url}/management/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: String(body),
  });
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({
    error: '无法处理请求，请检查输入或本机配置文件权限。',
  });
  expect(log).not.toHaveBeenCalled();
});

it('preserves idempotency key validation before JSON parsing', async () => {
  const response = await fetch(`${url}/management/echo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'bad key',
    },
    body: '{',
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'Idempotency-Key 无效。' });
});

it('classifies internal JSON parsing failures as server errors', async () => {
  const response = await fetch(`${url}/management/internal`);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: '操作未完成，请检查服务状态或存储权限。',
  });
  expect(log).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith('[http] Request failed', {
    status: 500,
    kind: 'SyntaxError',
    locations: expect.arrayContaining([
      expect.stringMatching(/http-middleware\.test\.ts:\d+:\d+$/),
    ]),
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain('upstream-secret');
});

it('logs only source locations and category while preserving the default 500 response', async () => {
  const response = await fetch(`${url}/default/internal?token=secret-query`, {
    headers: { Authorization: 'Bearer secret-header' },
  });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: '无法处理请求，请稍后重试。',
  });
  expect(log).toHaveBeenCalledExactlyOnceWith('[http] Request failed', {
    status: 500,
    kind: 'TypeError',
    locations: [
      'apps/server/src/example.ts:12:3',
      'packages/shared/src/example.ts:20:4',
    ],
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
});

it('preserves public AppError responses and logs only server failures', async () => {
  const expected = await fetch(`${url}/default/expected`);
  expect(expected.status).toBe(409);
  expect(await expected.json()).toEqual({ error: '公开错误' });
  expect(log).not.toHaveBeenCalled();
  const unavailable = await fetch(`${url}/default/unavailable`);
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: '服务暂不可用' });
  expect(log).toHaveBeenCalledOnce();
});

it('delegates errors after headers without formatting or writing another response', () => {
  const error = new Error('stream failed');
  const format = vi.fn();
  const next = vi.fn();
  const res = { headersSent: true, status: vi.fn(), json: vi.fn() };
  errorHandler(format)(
    error,
    {} as express.Request,
    res as unknown as Response,
    next,
  );
  expect(next).toHaveBeenCalledExactlyOnceWith(error);
  expect(format).not.toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});
