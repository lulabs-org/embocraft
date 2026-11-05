import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { matchMaker, Server } from '@colyseus/core';

import { env } from './core/config';
import { publicCors } from './core/http/cors';
import { installDocsRoutes } from './core/openapi/docs.routes';
import { installHealthRoutes } from './core/http/routes/health.routes';
import {
  DEFAULT_MANAGEMENT_PATHS,
  createManagementRouter,
} from './core/http/middleware/management-policy';
import { errorHandler } from './core/http/middleware/error-handler';
import { resolveServerUrls, type ServerUrls } from './core/http/address';
import {
  createDatabaseClient,
  resetDatabaseClient,
  setDatabaseClient,
} from './core/database/client';
import { checkStartupDatabase } from './core/database/health';
import { DatabaseManagementArchive } from './persistence/database-management-archive';

import type { SocketRoutes } from './core/transport/socket-routes';
import { RoutedWebSocketTransport } from './core/transport/websocket.transport';

import {
  AICharacterManager,
  CharacterQueries,
  createAICharacterRouter,
} from './modules/ai-characters';

import {
  AsrSettingsStore,
  DatabaseAsrServicePersistence,
  installAsrSocket,
  LocalSpeech,
  createAsrRouter,
} from './modules/asr';

import { createTtsRouter, ttsService } from './modules/tts';

import { GatewayAuth, installGatewaySocket } from './modules/gateway';

import {
  DatabaseProviderRepository,
  ProviderService,
  createProviderRouter,
} from './modules/providers';

import {
  ConsoleSyncCommands,
  createConsoleSyncRouter,
} from './modules/console-sync';

import { createTaskRouter } from './modules/tasks';

import {
  WorldRoom,
  WorldStore,
  createWorldRouter,
  createPresenceRouter,
} from './modules/world';
import { ChatStore, createChatRouter } from './modules/chat';

/**
 * 创建并装配服务器实例。
 * 纯粹的 0 参装配函数，直接从环境变量读取配置并连接数据库。
 */
export async function createServer() {
  const config = env.readServer();
  await checkStartupDatabase(config.databaseUrl);
  const gatewayAuth = new GatewayAuth(config.gateway);

  const db = createDatabaseClient(config.databaseUrl);
  setDatabaseClient(db);
  const providers = new DatabaseProviderRepository(db);
  const asrSettings = new AsrSettingsStore(
    new DatabaseAsrServicePersistence(db),
  );
  const store = new WorldStore(config.databaseUrl, db);
  let world: WorldRoom | undefined;
  let serverUrls: ServerUrls | undefined;
  const archive = new DatabaseManagementArchive(db);
  const characters = new AICharacterManager(
    providers,
    () => serverUrls?.wsUrl ?? '',
    archive,
  );
  const providerService = new ProviderService(
    providers,
    undefined,
    (id) => characters.hasProviderReference(id),
    () => characters.events.publish('providers'),
  );
  const speech = new LocalSpeech();
  const consoleSync = new ConsoleSyncCommands();
  const characterQueries = new CharacterQueries(db);

  const app = express();
  app.use(publicCors(config.webOrigin));
  installDocsRoutes(app);
  installHealthRoutes(app, config);

  // 1. 控制台管理路由网关
  app.use(
    createManagementRouter(
      DEFAULT_MANAGEMENT_PATHS,
      gatewayAuth.middleware,
      (management) => {
        management.use(
          createAICharacterRouter(characters, consoleSync, characterQueries),
        );
        management.use(createProviderRouter(providerService, consoleSync));
        management.use(createTaskRouter(characters.tasks, consoleSync));
        management.use(createConsoleSyncRouter(consoleSync));
      },
    ),
  );

  // 2. 语音与音频路由
  app.use(
    createAsrRouter({
      authenticateManagement: gatewayAuth.middleware,
      speech,
      asrSettings,
      origin: config.webOrigin,
    }),
  );
  app.use(
    createManagementRouter(
      '/voice/tts',
      gatewayAuth.middleware,
      (management) => {
        management.use(createTtsRouter());
      },
    ),
  );

  // 3. 游戏世界房间与聊天路由
  app.use(createWorldRouter(() => world?.roomId ?? ''));
  app.use(createPresenceRouter(() => world?.getPresence(), config.webOrigin));
  app.use(
    createChatRouter(
      () => world?.chat,
      speech,
      () => world?.agentSpeech,
      config.webOrigin,
      asrSettings,
    ),
  );

  app.use(errorHandler());
  const http = createHttpServer(app);
  // Sockets register module-by-module like HTTP routes; other upgrades reach Colyseus.
  const sockets: SocketRoutes = new Map();
  installGatewaySocket(sockets, {
    events: characters.events,
    auth: gatewayAuth,
  });
  installAsrSocket(sockets, {
    settings: asrSettings,
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
          resetDatabaseClient(db);
          await db?.$disconnect();
          world = undefined;
        }
      }
    })());
  const listen = async () => {
    if (closing || listening) throw Error('服务器已经启动或关闭。');
    listening = true;
    try {
      await server.listen(config.port, config.host);
      serverUrls = resolveServerUrls(
        http.address() as AddressInfo,
        config.host,
      );
      const listing = await matchMaker.createRoom('world', {});
      world = matchMaker.getLocalRoomById(listing.roomId) as WorldRoom;
      await characters.load();
      return serverUrls;
    } catch (error) {
      await close();
      throw error;
    }
  };

  return {
    listen,
    close,
    get httpUrl() {
      return serverUrls?.httpUrl ?? '';
    },
    get wsUrl() {
      return serverUrls?.wsUrl ?? '';
    },
    get url() {
      return serverUrls?.wsUrl ?? '';
    },
    _internals: {
      app,
      http,
      server,
      characters,
      providers,
      voiceServices: ttsService,
      asrSettings,
      get world() {
        return world!;
      },
    },
  };
}
