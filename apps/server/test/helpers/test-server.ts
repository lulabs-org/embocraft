import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerOptions } from '../../src/server';
import { env } from '../../src/core/config';
import {
  FileProviderRepository,
  bootstrapProviders,
} from '../../src/modules/providers';
import { VoiceServiceStore } from '../../src/modules/audio/tts/voice-services';
import { AsrSettingsStore } from '../../src/modules/audio/asr/asr-settings';
import {
  readManagementArchive,
  writeManagementArchive,
} from '../../src/persistence/archive-file';

/** Production assembly with isolated disk/world and a random loopback port by default. */
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
    const providers =
      options.providers ??
      new FileProviderRepository(join(directory, 'providers.json'));
    const archivePath =
      providers instanceof FileProviderRepository
        ? `${providers.path}.agents.json`
        : join(directory, 'providers.json.agents.json');
    if (!options.providers)
      await bootstrapProviders(providers, { DEEPSEEK_API_KEY: 'fixture-only' });
    server = await createServer({
      ...options,
      providers,
      archive: options.archive ?? {
        load: () => readManagementArchive(archivePath),
        save: (records) => writeManagementArchive(archivePath, records),
      },
      asrSettings:
        options.asrSettings ??
        new AsrSettingsStore(join(directory, 'asr-settings.json')),
      voiceServices:
        options.voiceServices ??
        new VoiceServiceStore(join(directory, 'voices.json')),
      config: env.readServer({
        PORT: String(options.port ?? 0),
        HOST: '127.0.0.1',
        WEB_ORIGIN: options.origin ?? 'http://127.0.0.1:5173',
        DATABASE_URL: '',
        VOICE_PROVIDER: 'mock',
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
