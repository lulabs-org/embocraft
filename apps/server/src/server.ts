import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server, matchMaker } from '@colyseus/core';

import { createApp } from './app';
import { env, type ServerConfig } from './config';
import { checkStartupDatabase } from './startup';
import type { ArchivePort } from './persistence/archive';
import { DatabaseManagementArchive } from './persistence/database-archive';
import { createDatabaseClient } from './persistence/database-client';
import type { PrismaClient } from '@prisma/client';

import type { SocketRoutes } from './transport/socket-routes';
import { RoutedWebSocketTransport } from './transport/websocket.transport';

import {
  AICharacterManager,
  type AICharacterDependencies,
} from './modules/ai-characters';

import { AsrSettingsStore } from './modules/audio/asr/asr-settings';
import {
  installAsrSocket,
  type AsrBridge,
} from './modules/audio/asr/asr.socket';
import { LocalSpeech } from './modules/audio/asr/local-speech';
import { createVoiceProvider } from './modules/audio/session';
import { VoiceServiceStore } from './modules/audio/tts/voice-services';

import { GatewayAuth } from './modules/gateway/auth';
import { installGatewaySocket } from './modules/gateway/socket';

import {
  DatabaseProviderRepository,
  type ProviderRepository,
  bootstrapProviders,
  ModelCatalog,
  ProviderHealthChecker,
  ProviderService,
} from './modules/providers';

import { WorldRoom } from './modules/world/room';
import { WorldStore } from './modules/world/store';

export type ServerOptions = {
  config?: ServerConfig;
  providers?: ProviderRepository;
  archive?: ArchivePort;
  voiceServices?: VoiceServiceStore;
  asrSettings?: AsrSettingsStore;
  speech?: LocalSpeech;
  worldStore?: WorldStore;
  agentDependencies?: AICharacterDependencies;
  databaseCheck?: (url: string) => Promise<void>;
  asrBridge?: AsrBridge;
};

const wsHost = (host: string) => {
  const h = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
  return h.includes(':') ? `[${h}]` : h;
};

type CoreStores = {
  gatewayAuth: GatewayAuth;
  providers: ProviderRepository;
  voiceServices: VoiceServiceStore;
  asrSettings: AsrSettingsStore;
};

/** Each store reads its own file, so loads are independent and parallel-safe. */
async function loadStores(
  config: ServerConfig,
  options: ServerOptions,
  db?: PrismaClient,
): Promise<CoreStores> {
  const providers = options.providers ?? new DatabaseProviderRepository(db!);
  const voiceServices = options.voiceServices ?? new VoiceServiceStore();
  const asrSettings = options.asrSettings ?? new AsrSettingsStore();
  const [gatewayAuth] = await Promise.all([
    GatewayAuth.load(config.gateway),
    bootstrapProviders(providers),
    voiceServices.load(),
    asrSettings.load(),
  ]);
  return { gatewayAuth, providers, voiceServices, asrSettings };
}

/** Owns one world's resources. Both production and tests use this lifecycle. */
export async function createServer(options: ServerOptions = {}) {
  const config = options.config ?? env.readServer();
  await (options.databaseCheck ?? checkStartupDatabase)(config.databaseUrl);
  if (!config.databaseUrl && !(options.providers && options.archive))
    throw new Error('必须配置 DATABASE_URL 才能持久化模型服务与 Agent 数据。');
  // Validate voice configuration before allocating the long-lived database client.
  const voiceProvider = createVoiceProvider(
    config.voice.provider,
    config.voice,
  );
  const db = config.databaseUrl
    ? createDatabaseClient(config.databaseUrl)
    : undefined;
  const { gatewayAuth, providers, voiceServices, asrSettings } =
    await loadStores(config, options, db).catch(async (error) => {
      await db?.$disconnect();
      throw error;
    });
  const store = options.worldStore ?? new WorldStore(config.databaseUrl);
  let world: WorldRoom | undefined;
  let url = '';
  const archive = options.archive ?? new DatabaseManagementArchive(db!);
  const characters = new AICharacterManager(
    providers,
    () => url,
    options.agentDependencies,
    voiceServices,
    archive,
  );
  const modelCatalog = new ModelCatalog(providers);
  const providerHealth = new ProviderHealthChecker(providers);
  const providerService = new ProviderService(
    providers,
    modelCatalog,
    (id) => characters.hasProviderReference(id),
    () => characters.events.publish('providers'),
    providerHealth,
  );
  const speech = options.speech ?? new LocalSpeech();
  const app = createApp({
    origin: config.webOrigin,
    health: config,
    management: {
      authenticate: gatewayAuth.middleware,
      characters,
      tasks: characters.tasks,
      providers: providerService,
    },
    audio: {
      authenticateManagement: gatewayAuth.middleware,
      speech,
      asrSettings,
      voiceServices,
      removeVoiceService: (id) => characters.removeVoiceService(id),
    },
    world: {
      roomId: () => world?.roomId ?? '',
      presence: () => world?.getPresence(),
    },
    chat: {
      getChat: () => world?.chat,
      speech,
      getAgentSpeech: () => world?.agentSpeech,
    },
  });
  const http = createHttpServer(app);
  // Sockets register module-by-module like HTTP routes; other upgrades reach Colyseus.
  const sockets: SocketRoutes = new Map();
  installGatewaySocket(sockets, {
    events: characters.events,
    auth: gatewayAuth,
  });
  installAsrSocket(sockets, {
    settings: asrSettings,
    bridge: options.asrBridge,
    origin: config.webOrigin,
  });
  const transport = new RoutedWebSocketTransport(http, sockets);
  const server = new Server({
    transport,
    greet: false,
    gracefullyShutdown: false,
  });
  server.define('world', WorldRoom, {
    voiceServices,
    store,
    voiceProvider,
    realtimeConfig: () => config.realtime,
  });
  server.onBeforeShutdown(() => characters.close());
  let closing: Promise<void> | undefined;
  let listening = false;
  const close = () =>
    (closing ??= (async () => {
      try {
        await server.gracefullyShutdown(false);
      } finally {
        // Colyseus closes its players; explicitly close ASR upgrades and HTTP/SSE too.
        transport.closeConnections();
        if (http.listening) {
          http.close();
          http.closeAllConnections();
          await once(http, 'close');
        }
        try {
          if (!world) await store.close();
        } finally {
          await db?.$disconnect();
          world = undefined;
        }
      }
    })());
  return {
    app,
    http,
    server,
    characters,
    providers,
    voiceServices,
    asrSettings,
    get world() {
      if (!world) throw Error('世界尚未启动。');
      return world;
    },
    get url() {
      return url;
    },
    close,
    async listen() {
      if (closing || listening) throw Error('服务器已经启动或关闭。');
      listening = true;
      try {
        await server.listen(config.port, config.host);
        url = `ws://${wsHost(config.host)}:${(http.address() as AddressInfo).port}`;
        const listing = await matchMaker.createRoom('world', {});
        world = matchMaker.getLocalRoomById(listing.roomId) as WorldRoom;
        await characters.load();
        return url;
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}
