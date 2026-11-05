import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDatabaseClient } from '../src/core/database/client';
import { createServer } from '../src/server';

vi.mock('../src/core/database/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/database/client')>()),
  createDatabaseClient: vi.fn(),
}));

vi.mock('../src/core/database/health', () => ({
  checkStartupDatabase: vi.fn(),
}));

const disconnect = vi.fn();
const loadWorld = vi.fn();
const findProviders = vi.fn().mockResolvedValue([]);
const findTtsProviders = vi.fn().mockResolvedValue([]);
const findAsrProviders = vi.fn().mockResolvedValue([]);
const findAssignments = vi.fn().mockResolvedValue([]);
const findCharacters = vi.fn().mockResolvedValue([]);
const findPlans = vi.fn().mockResolvedValue([]);
const findRuns = vi.fn().mockResolvedValue([]);
const findRequests = vi.fn().mockResolvedValue([]);
const transaction = vi.fn();
const db = {
  $disconnect: disconnect,
  world: { upsert: loadWorld },
  agentProvider: { findMany: findProviders },
  ttsProvider: { findMany: findTtsProviders },
  asrProvider: { findMany: findAsrProviders },
  asrAssignment: { findMany: findAssignments },
  agentCharacter: { findMany: findCharacters },
  agentPlan: { findMany: findPlans },
  agentRun: { findMany: findRuns },
  agentRequest: { findMany: findRequests },
  $transaction: transaction,
} as unknown as PrismaClient;

let server: Awaited<ReturnType<typeof createServer>> | undefined;

beforeEach(async () => {
  vi.resetAllMocks();
  process.env.DATABASE_URL = 'postgresql://fixture/world';
  process.env.SERVER_PORT = '0';
  process.env.SERVER_HOST = '127.0.0.1';
  process.env.AGENT_GATEWAY_TOKEN = 'fixture-gateway-token-for-tests';
  for (const findMany of [
    findProviders,
    findTtsProviders,
    findAsrProviders,
    findAssignments,
    findCharacters,
    findPlans,
    findRuns,
    findRequests,
  ])
    findMany.mockResolvedValue([]);
  transaction.mockImplementation(async (fn: unknown) =>
    typeof fn === 'function'
      ? (fn as (client: PrismaClient) => unknown)(db)
      : fn,
  );
  vi.mocked(createDatabaseClient).mockReturnValue(db);
  loadWorld.mockResolvedValue({ revision: 0, edits: [] });
});

afterEach(async () => {
  try {
    await server?.close();
  } finally {
    server = undefined;
    vi.restoreAllMocks();
  }
});

it('shares the runtime client with the world and disconnects once after its consumers stop', async () => {
  server = await createServer();
  await server.listen();
  expect(createDatabaseClient).toHaveBeenCalledOnce();
  expect(loadWorld).toHaveBeenCalledOnce();
  expect(server._internals.world.getPresence().persistence).toBe('postgresql');
  const dispose = server._internals.world.onDispose.bind(
    server._internals.world,
  );
  let worldDisposed = false;
  vi.spyOn(server._internals.world, 'onDispose').mockImplementation(
    async () => {
      await dispose();
      expect(disconnect).not.toHaveBeenCalled();
      worldDisposed = true;
    },
  );
  const closeCharacters = vi.spyOn(server._internals.characters, 'close');
  disconnect.mockImplementation(() => {
    expect(worldDisposed).toBe(true);
    expect(closeCharacters).toHaveBeenCalledOnce();
  });
  await Promise.all([server.close(), server.close()]);
  expect(disconnect).toHaveBeenCalledOnce();
});

it('releases the runtime client when closing before listen', async () => {
  server = await createServer();
  await Promise.all([server.close(), server.close()]);
  expect(loadWorld).not.toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalledOnce();
});

it('releases the runtime client after failed world startup and allows another server to start', async () => {
  loadWorld.mockRejectedValueOnce(new Error('world unavailable'));
  server = await createServer();
  await expect(server.listen()).rejects.toThrow('world unavailable');
  await server.close();
  expect(disconnect).toHaveBeenCalledOnce();
  server = await createServer();
  await server.listen();
  await server.close();
  expect(disconnect).toHaveBeenCalledTimes(2);
});
