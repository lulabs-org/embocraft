import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { matchMaker, Server } from '@colyseus/core';

import type { PrismaClient } from '@prisma/client';
import { createApp } from './app';
import { env, type ServerConfig } from './core/config';
import { createDatabaseClient } from './core/database/client';
import { checkStartupDatabase } from './core/database/health';
import type { ArchivePort } from './persistence/archive';
import { DatabaseManagementArchive } from './persistence/database-archive';

import type { SocketRoutes } from './core/transport/socket-routes';
import { RoutedWebSocketTransport } from './core/transport/websocket.transport';

import {
  AICharacterManager,
  CharacterQueries,
  type CharacterQueryPort,
  type AICharacterDependencies,
} from './modules/ai-characters';

import {
  AsrSettingsStore,
  DatabaseAsrServicePersistence,
  installAsrSocket,
  LocalSpeech,
  type AsrBridge,
} from './modules/asr';

import {
  DatabaseVoiceServicePersistence,
  VoiceServiceStore,
} from './modules/tts';

import { GatewayAuth, installGatewaySocket } from './modules/gateway';

import {
  DatabaseProviderRepository,
  ModelCatalog,
  ProviderHealthChecker,
  ProviderService,
  type ProviderRepository,
} from './modules/providers';

import { WorldRoom, WorldStore } from './modules/world';
import { ChatStore } from './modules/chat';

export type ServerOptions = {
  config?: ServerConfig;
  providers?: ProviderRepository;
  archive?: ArchivePort;
  characterQueries?: CharacterQueryPort;
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

/** Independent catalogs load before routes and character restoration. */
async function loadStores(
  config: ServerConfig,
  options: ServerOptions,
  db?: PrismaClient,
): Promise<CoreStores> {
  const providers = options.providers ?? new DatabaseProviderRepository(db);
  const voiceServices =
    options.voiceServices ??
    new VoiceServiceStore(new DatabaseVoiceServicePersistence(db));
  const asrSettings =
    options.asrSettings ??
    new AsrSettingsStore(new DatabaseAsrServicePersistence(db));
  const loads = [
    GatewayAuth.load(config.gateway),
    providers.load(),
    voiceServices.load(),
    asrSettings.load(),
  ] as const;
  const [gatewayAuth] = await Promise.all(loads).catch(async (error) => {
    // Finish pending I/O before the caller releases the shared database client.
    await Promise.allSettled(loads);
    throw error;
  });
  return { gatewayAuth, providers, voiceServices, asrSettings };
}

/** Owns one world's resources. Both production and tests use this lifecycle. */
export async function createServer(options: ServerOptions = {}) {
  const config = options.config ?? env.readServer();
  await (options.databaseCheck ?? checkStartupDatabase)(config.databaseUrl);
  if (
    !config.databaseUrl &&
    !(options.providers && options.archive && options.characterQueries)
  )
    throw new Error('必须配置 DATABASE_URL 才能持久化模型服务与 Agent 数据。');
  const db = config.databaseUrl
    ? createDatabaseClient(config.databaseUrl)
    : undefined;
  const { gatewayAuth, providers, voiceServices, asrSettings } =
    await loadStores(config, options, db).catch(async (error) => {
      await db?.$disconnect();
      throw error;
    });
  const store = options.worldStore ?? new WorldStore(config.databaseUrl, db);
  let world: WorldRoom | undefined;
  let url = '';
  const archive = options.archive ?? new DatabaseManagementArchive(db);
  const characters = new AICharacterManager(
    providers,
    () => url,
    archive,
    options.agentDependencies,
    voiceServices,
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
      characterQueries: options.characterQueries ?? new CharacterQueries(db),
      tasks: characters.tasks,
      providers: providerService,
    },
    asr: {
      authenticateManagement: gatewayAuth.middleware,
      speech,
      asrSettings,
    },
    tts: {
      authenticateManagement: gatewayAuth.middleware,
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
  const chatStore = new ChatStore(db);
  server.define('world', WorldRoom, {
    voiceServices,
    store,
    chatStore,
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
