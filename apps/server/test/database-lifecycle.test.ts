import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from '../src/server';
import { env } from '../src/core/config';
import { createDatabaseClient } from '../src/core/database/client';
import { FileProviderRepository } from '../src/modules/providers';
import { AsrSettingsStore, VoiceServiceStore } from '../src/modules/audio';
import { WorldStore } from '../src/modules/world';

vi.mock('../src/core/database/client', () => ({
  createDatabaseClient: vi.fn(),
}));

const disconnect = vi.fn();
const loadWorld = vi.fn();
const db = {
  $disconnect: disconnect,
  world: { upsert: loadWorld },
} as unknown as PrismaClient;
let directory: string;
let server: Awaited<ReturnType<typeof createServer>> | undefined;

beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(createDatabaseClient).mockReturnValue(db);
  loadWorld.mockResolvedValue({ revision: 0, edits: [] });
  directory = await mkdtemp(join(tmpdir(), 'voxel-database-lifecycle-'));
});

afterEach(async () => {
  try {
    await server?.close();
  } finally {
    server = undefined;
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});

function options() {
  return {
    config: env.readServer({
      DATABASE_URL: 'postgresql://fixture/world',
      PORT: '0',
      HOST: '127.0.0.1',
      AGENT_GATEWAY_TOKEN: 'fixture-gateway-token-for-tests',
    }),
    databaseCheck: async () => {},
    providers: new FileProviderRepository(join(directory, 'providers.json')),
    voiceServices: new VoiceServiceStore(join(directory, 'voices.json')),
    asrSettings: new AsrSettingsStore(join(directory, 'asr.json')),
    archive: { load: async () => undefined, save: async () => {} },
  };
}

it('shares the runtime client with the world and disconnects once after its consumers stop', async () => {
  server = await createServer(options());
  await server.listen();
  expect(createDatabaseClient).toHaveBeenCalledOnce();
  expect(loadWorld).toHaveBeenCalledOnce();
  expect(server.world.getPresence().persistence).toBe('postgresql');
  const dispose = server.world.onDispose.bind(server.world);
  let worldDisposed = false;
  vi.spyOn(server.world, 'onDispose').mockImplementation(async () => {
    await dispose();
    expect(disconnect).not.toHaveBeenCalled();
    worldDisposed = true;
  });
  const closeCharacters = vi.spyOn(server.characters, 'close');
  disconnect.mockImplementation(() => {
    expect(worldDisposed).toBe(true);
    expect(closeCharacters).toHaveBeenCalledOnce();
  });
  await Promise.all([server.close(), server.close()]);
  expect(disconnect).toHaveBeenCalledOnce();
});

it('releases the runtime client when closing before listen', async () => {
  server = await createServer(options());
  await Promise.all([server.close(), server.close()]);
  expect(loadWorld).not.toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalledOnce();
});

it('releases the runtime client when catalog loading fails', async () => {
  const dependencies = options();
  vi.spyOn(dependencies.providers, 'load').mockRejectedValue(
    new Error('catalog unavailable'),
  );
  await expect(createServer(dependencies)).rejects.toThrow(
    'catalog unavailable',
  );
  expect(disconnect).toHaveBeenCalledOnce();
  expect(loadWorld).not.toHaveBeenCalled();
});

it('waits for all catalog loads before disconnecting and preserves the first failure', async () => {
  const dependencies = options();
  const firstError = new Error('voice catalog unavailable');
  let failProviders!: () => void;
  const providerLoad = new Promise<boolean>((_, reject) => {
    failProviders = () => reject(new Error('provider catalog unavailable'));
  });
  let finishAsr!: () => void;
  const asrLoad = new Promise<void>((resolve) => {
    finishAsr = resolve;
  });
  const providers = vi
    .spyOn(dependencies.providers, 'load')
    .mockReturnValue(providerLoad);
  const voices = vi
    .spyOn(dependencies.voiceServices, 'load')
    .mockRejectedValue(firstError);
  const asr = vi
    .spyOn(dependencies.asrSettings, 'load')
    .mockReturnValue(asrLoad);
  const settled = vi.fn();
  const outcome = createServer(dependencies).then(settled, (error: unknown) => {
    settled();
    return error;
  });

  try {
    await setImmediate();
    expect(providers).toHaveBeenCalledOnce();
    expect(voices).toHaveBeenCalledOnce();
    expect(asr).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();

    failProviders();
    await setImmediate();
    expect(settled).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();

    finishAsr();
    expect(await outcome).toBe(firstError);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(loadWorld).not.toHaveBeenCalled();
  } finally {
    failProviders();
    finishAsr();
    await outcome;
  }
});

it('releases the runtime client after failed world startup and allows another server to start', async () => {
  loadWorld.mockRejectedValueOnce(new Error('world unavailable'));
  server = await createServer(options());
  await expect(server.listen()).rejects.toThrow('world unavailable');
  await server.close();
  expect(disconnect).toHaveBeenCalledOnce();
  server = await createServer(options());
  await server.listen();
  await server.close();
  expect(disconnect).toHaveBeenCalledTimes(2);
});

it('preserves an explicitly injected world store and its existing close lifecycle', async () => {
  const worldStore = new WorldStore('');
  const closeWorld = vi.spyOn(worldStore, 'close');
  server = await createServer({ ...options(), worldStore });
  await server.listen();
  expect(server.world.getPresence().persistence).toBe('memory');
  expect(loadWorld).not.toHaveBeenCalled();
  await server.close();
  expect(closeWorld).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalledOnce();
});
