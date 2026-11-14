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
import { db } from './core/database/client';
import { checkStartupDatabase } from './core/database/health';

import type { SocketRoutes } from './core/transport/socket-routes';
import { RoutedWebSocketTransport } from './core/transport/websocket.transport';

import {
  createAICharacterOrchestrator,
  CharacterQueries,
  createAICharacterRouter,
} from './modules/ai-characters';
import { asrService, createAsrRouter, installAsrSocket } from './modules/asr';
import { createTtsRouter, ttsService } from './modules/tts';
import { GatewayAuth, installGatewaySocket } from './modules/gateway';
import { createProviderRouter, providerRepository } from './modules/providers';
import { consoleSync, createConsoleSyncRouter } from './modules/console-sync';
import { createTaskRouter } from './modules/tasks';
import { WorldRoom, createWorldRouter, getActiveWorld } from './modules/world';
import { createChatRouter } from './modules/chat';

/**
 * 创建并装配服务器实例。
 * 纯粹的 0 参装配函数，直接从环境变量读取配置并连接数据库。
 */
export async function createServer() {
  const config = env.readServer();
  await checkStartupDatabase();
  const gatewayAuth = new GatewayAuth(config.gateway);

  let serverUrls: ServerUrls | undefined;
  const characters = createAICharacterOrchestrator(
    undefined,
    () => serverUrls?.wsUrl ?? '',
  );

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
          createAICharacterRouter(new CharacterQueries(), characters),
        );
        management.use(createProviderRouter());
        management.use(createTaskRouter(characters.tasks));
        management.use(createConsoleSyncRouter());
      },
    ),
  );

  // 2. 语音与音频路由
  app.use(
    ['/voice/asr/services', '/voice/asr/defaults', '/voice/asr/models'],
    gatewayAuth.middleware,
  );
  app.use('/voice/asr/assignments', (req, res, next) => {
    if (req.method === 'GET') next();
    else gatewayAuth.middleware(req, res, next);
  });
  app.use(createAsrRouter());
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
  app.use(createWorldRouter(getActiveWorld));
  app.use(createChatRouter(getActiveWorld));

  app.use(errorHandler());
  const http = createHttpServer(app);
  // Sockets register module-by-module like HTTP routes; other upgrades reach Colyseus.
  const sockets: SocketRoutes = new Map();
  installGatewaySocket(sockets, gatewayAuth, characters.events);
  installAsrSocket(sockets);
  const transport = new RoutedWebSocketTransport(http, sockets);
  const server = new Server({
    transport,
    greet: false,
    gracefullyShutdown: false,
  });
  server.define('world', WorldRoom);
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
        consoleSync.reset();
        await db.$disconnect();
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
      await matchMaker.createRoom('world', {});
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
      providers: providerRepository,
      voiceServices: ttsService,
      asrSettings: asrService,
      get world() {
        return getActiveWorld()!;
      },
    },
  };
}
