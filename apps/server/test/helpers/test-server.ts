import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../../src/core/config';
import { bootstrapProviders } from '../../src/modules/providers';
import { createServer, type ServerOptions } from '../../src/server';
import {
  TestAsrSettingsStore as AsrSettingsStore,
  MemoryArchive,
  MemoryProviderRepository,
  TestVoiceServiceStore as VoiceServiceStore,
} from './memory-storage';

/** Production assembly with isolated in-memory stores/world and a random loopback port by default. */
export async function createTestServer(
  options: Omit<ServerOptions, 'config'> & {
    directory?: string;
    port?: number;
    origin?: string;
  } = {},
) {
  const directory =
    options.directory ?? (await mkdtemp(join(tmpdir(), 'voxel-test-')));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    const providers = options.providers ?? new MemoryProviderRepository();
    if (!options.providers) {
      await bootstrapProviders(providers);
      await providers.save(
        {
          name: 'DeepSeek',
          type: 'deepseek',
          apiKey: 'fixture-only',
          defaultModel: 'deepseek-flash',
        },
        'deepseek',
      );
    }
    server = await createServer({
      ...options,
      providers,
      archive:
        options.archive ??
        (providers instanceof MemoryProviderRepository
          ? providers.archive
          : new MemoryArchive()),
      asrSettings: options.asrSettings ?? new AsrSettingsStore(),
      voiceServices: options.voiceServices ?? new VoiceServiceStore(),
      config: env.readServer({
        SERVER_PORT: String(options.port ?? 0),
        SERVER_HOST: '127.0.0.1',
        WEB_ORIGIN: options.origin ?? 'http://127.0.0.1:5173',
        DATABASE_URL: '',
        AGENT_GATEWAY_TOKEN: 'fixture-gateway-token-for-tests',
        AGENT_GATEWAY_TOKEN_FILE: join(directory, 'gateway-token'),
      }),
      databaseCheck: async () => {},
    });
    await server.listen();
    const running = server;
    let closing: Promise<void> | undefined;
    return {
      ...running,
      directory,
      httpUrl: running.url.replace(/^ws:/, 'http:'),
      close: () =>
        (closing ??= (async () => {
          try {
            await running.close();
          } finally {
            if (!options.directory)
              await rm(directory, { recursive: true, force: true });
          }
        })()),
    };
  } catch (error) {
    await server?.close();
    if (!options.directory)
      await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
