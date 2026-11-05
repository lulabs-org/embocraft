import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseClient } from '../../src/core/database/client';
import { createServer } from '../../src/server';
import type { AICharacterDependencies } from '../../src/modules/ai-characters';
import type { AsrBridge, LocalSpeech } from '../../src/modules/asr';

export type TestServerOptions = {
  directory?: string;
  port?: number;
  origin?: string;
  agentDependencies?: AICharacterDependencies;
  asrBridge?: AsrBridge;
  speech?: LocalSpeech;
  [key: string]: unknown;
};

/** Production assembly with a random loopback port by default. */
export async function createTestServer(options: TestServerOptions = {}) {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.endsWith('_test'))
    throw new Error('TEST_DATABASE_URL 必须指向专用的 _test 数据库。');
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = testDatabaseUrl;
  const cleanup = createDatabaseClient(testDatabaseUrl);
  try {
    const tables = await cleanup.$queryRawUnsafe<Array<{ tablename: string }>>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'",
    );
    if (tables.length) {
      const names = tables
        .map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`)
        .join(', ');
      await cleanup.$executeRawUnsafe(
        `TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`,
      );
    }
  } catch (error) {
    if (previousDatabaseUrl !== undefined)
      process.env.DATABASE_URL = previousDatabaseUrl;
    else delete process.env.DATABASE_URL;
    throw error;
  } finally {
    await cleanup.$disconnect();
  }
  const directory =
    options.directory ?? (await mkdtemp(join(tmpdir(), 'voxel-test-')));
  const prevPort = process.env.SERVER_PORT;
  const prevOrigin = process.env.WEB_ORIGIN;
  const prevToken = process.env.AGENT_GATEWAY_TOKEN;
  const prevGatewayOrigins = process.env.AGENT_GATEWAY_ALLOWED_ORIGINS;

  const restoreDatabaseUrl = () => {
    if (previousDatabaseUrl !== undefined)
      process.env.DATABASE_URL = previousDatabaseUrl;
    else delete process.env.DATABASE_URL;
  };

  process.env.SERVER_PORT = String(options.port ?? 0);
  process.env.AGENT_GATEWAY_TOKEN = 'fixture-gateway-token-for-tests';
  if (options.origin) {
    process.env.WEB_ORIGIN = options.origin;
    process.env.AGENT_GATEWAY_ALLOWED_ORIGINS =
      options.origin === '*' ? 'http://127.0.0.1:5173' : options.origin;
  }

  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    server = await createServer();
    await server.listen();
    const current = await (async () => {
      try {
        return await server._internals.providers.getRuntime('deepseek');
      } catch {
        return undefined;
      }
    })();
    if (!current?.apiKey) {
      await server._internals.providers.save(
        {
          name: 'DeepSeek',
          type: 'deepseek',
          defaultModel: 'deepseek-chat',
          apiKey: 'fixture-api-key-deepseek',
        },
        'deepseek',
      );
    }
    const running = server;
    let closing: Promise<void> | undefined;
    return {
      ...running,
      ...running._internals,
      get world() {
        return running._internals.world;
      },
      directory,
      httpUrl: running.url.replace(/^ws:/, 'http:'),
      close: () =>
        (closing ??= (async () => {
          try {
            await running.close();
          } finally {
            if (prevPort !== undefined) process.env.SERVER_PORT = prevPort;
            else delete process.env.SERVER_PORT;
            if (prevOrigin !== undefined) process.env.WEB_ORIGIN = prevOrigin;
            else delete process.env.WEB_ORIGIN;
            if (prevToken !== undefined)
              process.env.AGENT_GATEWAY_TOKEN = prevToken;
            else delete process.env.AGENT_GATEWAY_TOKEN;
            if (prevGatewayOrigins !== undefined)
              process.env.AGENT_GATEWAY_ALLOWED_ORIGINS = prevGatewayOrigins;
            else delete process.env.AGENT_GATEWAY_ALLOWED_ORIGINS;
            restoreDatabaseUrl();
            if (!options.directory)
              await rm(directory, { recursive: true, force: true });
          }
        })()),
    };
  } catch (error) {
    if (prevPort !== undefined) process.env.SERVER_PORT = prevPort;
    else delete process.env.SERVER_PORT;
    if (prevOrigin !== undefined) process.env.WEB_ORIGIN = prevOrigin;
    else delete process.env.WEB_ORIGIN;
    if (prevToken !== undefined) process.env.AGENT_GATEWAY_TOKEN = prevToken;
    else delete process.env.AGENT_GATEWAY_TOKEN;
    if (prevGatewayOrigins !== undefined)
      process.env.AGENT_GATEWAY_ALLOWED_ORIGINS = prevGatewayOrigins;
    else delete process.env.AGENT_GATEWAY_ALLOWED_ORIGINS;
    restoreDatabaseUrl();
    await server?.close();
    if (!options.directory)
      await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
