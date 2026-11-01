import express, { type RequestHandler } from 'express';
import type { WorldPresence } from '@voxel/shared';
import { publicCors } from './core/http/cors';
import { installDocsRoutes } from './core/openapi/docs.routes';
import {
  installHealthRoutes,
  type HealthConfig,
} from './core/http/routes/health.routes';
import { installManagementHttp } from './modules/management';
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
import { installTtsHttp, type TtsRouteDependencies } from './modules/tts';
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
  asr: Omit<AsrRouteDependencies, 'origin'>;
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
  installManagementHttp(app, {
    authenticate: deps.management.authenticate,
    receiptBody: taskCommandBody,
    installRoutes: (app, commands) => {
      installAICharacterRoutes(
        app,
        deps.management.characters,
        commands,
        deps.management.characterQueries,
      );
      installProviderRoutes(app, deps.management.providers, commands);
      installTaskRoutes(app, deps.management.tasks, commands);
    },
  });
  installAsrHttp(app, { ...deps.asr, origin: deps.origin });
  installTtsHttp(app, deps.tts);
  installWorldRoutes(app, deps.world.roomId);
  installChatRoutes(
    app,
    deps.chat.getChat,
    deps.chat.speech,
    deps.chat.getAgentSpeech,
    deps.origin,
    deps.asr.asrSettings,
  );
  installPresenceRoutes(app, deps.world.presence, deps.origin);
  app.use(errorHandler());
  return app;
}
