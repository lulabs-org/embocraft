import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkStartupDatabase, databaseStartupMessage } from './health';

const db = vi.hoisted(() => ({
  $connect: vi.fn(),
  $disconnect: vi.fn(),
  world: { findFirst: vi.fn() },
  agentProvider: { findFirst: vi.fn() },
  agentProviderState: { findFirst: vi.fn() },
  agentCharacter: { findFirst: vi.fn() },
  agentPlan: { findFirst: vi.fn() },
  agentRun: { findFirst: vi.fn() },
  agentRequest: { findFirst: vi.fn() },
  ttsService: { findFirst: vi.fn() },
  ttsCatalogState: { findFirst: vi.fn() },
  asrService: { findFirst: vi.fn() },
}));
const createClient = vi.hoisted(() => vi.fn());
vi.mock('@prisma/client', () => ({ PrismaClient: createClient }));

const localUrl =
  'postgresql://voxel:secret@127.0.0.1:55432/voxel?schema=public';

describe('database startup diagnostics', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    createClient.mockImplementation(() => db);
    db.$connect.mockResolvedValue(undefined);
    db.$disconnect.mockResolvedValue(undefined);
    db.world.findFirst.mockResolvedValue(null);
    for (const table of [
      db.agentProvider,
      db.agentProviderState,
      db.agentCharacter,
      db.agentPlan,
      db.agentRun,
      db.agentRequest,
      db.ttsService,
      db.ttsCatalogState,
      db.asrService,
    ])
      table.findFirst.mockResolvedValue(null);
    vi.stubEnv('DATABASE_URL', localUrl);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('checks connectivity and schema without modifying the world', async () => {
    await checkStartupDatabase();
    expect(db.$connect).toHaveBeenCalledOnce();
    expect(db.world.findFirst).toHaveBeenCalledWith({ select: { id: true } });
    for (const table of [
      db.agentProvider,
      db.agentProviderState,
      db.agentCharacter,
      db.agentPlan,
      db.agentRun,
      db.ttsService,
      db.ttsCatalogState,
      db.asrService,
    ])
      expect(table.findFirst).toHaveBeenCalledWith({ select: { id: true } });
    expect(db.agentRequest.findFirst).toHaveBeenCalledWith({
      select: { key: true },
    });
    expect(db.$disconnect).toHaveBeenCalledOnce();
  });

  it('sanitizes client construction failures before a connection exists', async () => {
    createClient.mockImplementation(() => {
      throw new Error(`sensitive connection: ${localUrl}`);
    });
    await expect(checkStartupDatabase()).rejects.toThrow('数据库启动检查失败');
    await expect(checkStartupDatabase()).rejects.not.toThrow('secret');
    expect(db.$disconnect).not.toHaveBeenCalled();
  });

  it('rejects an unreachable database with manual recovery steps and no credentials', async () => {
    db.$connect.mockRejectedValue({
      errorCode: 'P1001',
      message: `sensitive Prisma details: ${localUrl}`,
    });
    const error = await checkStartupDatabase().catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('127.0.0.1:55432');
    expect((error as Error).message).toContain('node scripts/database.mjs');
    expect((error as Error).message).toContain('后端未启动');
    expect((error as Error).message).not.toContain('secret');
    expect((error as Error).message).not.toContain('Prisma');
    expect(db.world.findFirst).not.toHaveBeenCalled();
    expect(db.$disconnect).toHaveBeenCalledOnce();
  });

  it('reports missing tables and still disconnects', async () => {
    db.world.findFirst.mockRejectedValue({ code: 'P2021' });
    await expect(checkStartupDatabase()).rejects.toThrow('pnpm db:migrate');
    expect(db.$disconnect).toHaveBeenCalledOnce();
  });

  it('does not mask the original failure if disconnect fails', async () => {
    db.$connect.mockRejectedValue({ errorCode: 'P1000' });
    db.$disconnect.mockRejectedValue(new Error('cleanup failed'));
    await expect(checkStartupDatabase()).rejects.toThrow('身份验证');
  });

  it('requires a configured database without creating a client', async () => {
    vi.stubEnv('DATABASE_URL', '');
    await expect(checkStartupDatabase()).rejects.toThrow('DATABASE_URL');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('does not suggest starting the project database for an external database', () => {
    const message = databaseStartupMessage(
      { errorCode: 'P1001' },
      'postgresql://user:secret@db.example.com:5432/custom',
    );
    expect(message).toContain('db.example.com:5432');
    expect(message).not.toContain('node scripts/database.mjs');
    expect(message).not.toContain('secret');
  });

  it('does not expose invalid connection strings or unrecognized error details', () => {
    const message = databaseStartupMessage(
      new Error('secret'),
      'invalid-secret',
    );
    expect(message).toContain('数据库启动检查失败');
    expect(message).not.toContain('secret');
  });
});
