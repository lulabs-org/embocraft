import express, { type RequestHandler } from 'express';
import type { WorldPresence } from '@voxel/shared';
import { publicCors } from './core/http/cors';
import { installDocsRoutes } from './core/openapi/docs.routes';
import {
  installHealthRoutes,
  type HealthConfig,
} from './core/http/routes/health.routes';
import {
  DEFAULT_MANAGEMENT_PATHS,
  createManagementRouter,
} from './core/http/middleware/management-policy';
import {
  ConsoleSyncCommands,
  installConsoleSyncRoutes,
} from './modules/console-sync';
import {
  installAICharacterRoutes,
  type AICharacterRoutePort,
  type CharacterQueryPort,
} from './modules/ai-characters';
import {
  installProviderRoutes,
  type ProviderService,
} from './modules/providers';
import {
  taskCommandBody,
  installTaskRoutes,
  type TaskPort,
} from './modules/tasks';
import { errorHandler } from './core/http/middleware/error-handler';
import { installAsrHttp, type AsrRouteDependencies } from './modules/asr';
import {
  installTtsHttp,
  PiperModels,
  type TtsRouteDependencies,
} from './modules/tts';
import { installChatRoutes } from './modules/chat';
import { installWorldRoutes, installPresenceRoutes } from './modules/world';

export type AppDependencies = {
  origin: string;
  health: HealthConfig;
  management: {
    authenticate: RequestHandler;
    characters: AICharacterRoutePort;
    characterQueries: CharacterQueryPort;
    providers: ProviderService;
    tasks: TaskPort;
  };
  asr: Omit<AsrRouteDependencies, 'origin' | 'ttsStatus'>;
  tts: TtsRouteDependencies;
  world: {
    roomId: () => string;
    presence: () => WorldPresence | undefined;
  };
  chat: {
    getChat: Parameters<typeof installChatRoutes>[1];
    speech: AsrRouteDependencies['speech'];
    getAgentSpeech: NonNullable<Parameters<typeof installChatRoutes>[3]>;
  };
};

/** HTTP composition only: no sockets, dotenv, database connections or task timers. */
export function createApp(deps: AppDependencies) {
  const app = express();
  app.use(publicCors(deps.origin));
  installDocsRoutes(app);
  installHealthRoutes(app, deps.health);
  // 控制台数据同步与命令并发队列
  const consoleSync = new ConsoleSyncCommands(taskCommandBody);
  app.use(
    createManagementRouter(
      DEFAULT_MANAGEMENT_PATHS,
      deps.management.authenticate,
      (router) => {
        installAICharacterRoutes(
          router,
          deps.management.characters,
          consoleSync,
          deps.management.characterQueries,
        );
        installProviderRoutes(router, deps.management.providers, consoleSync);
        installTaskRoutes(router, deps.management.tasks, consoleSync);
        installConsoleSyncRoutes(router, consoleSync);
      },
    ),
  );
  installAsrHttp(app, {
    ...deps.asr,
    origin: deps.origin,
    ttsStatus: () => new PiperModels().status(),
  });
  installTtsHttp(app, deps.tts);
  installWorldRoutes(app, deps.world.roomId);
  installPresenceRoutes(app, deps.world.presence, deps.origin);
  installChatRoutes(
    app,
    deps.chat.getChat,
    deps.chat.speech,
    deps.chat.getAgentSpeech,
    deps.origin,
    deps.asr.asrSettings,
  );
  app.use(errorHandler());
  return app;
}
