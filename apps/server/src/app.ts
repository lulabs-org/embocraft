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
} from './modules/ai-characters';
import {
  installProviderRoutes,
  type ProviderRouteDependencies,
} from './modules/providers';
import {
  taskCommandBody,
  installTaskRoutes,
  type TaskPort,
} from './modules/tasks';
import { errorHandler } from './core/http/middleware/error-handler';
import {
  installAudioRoutes,
  type AudioRouteDependencies,
} from './modules/audio';
import { installChatRoutes } from './modules/chat';
import { installWorldRoutes, installPresenceRoutes } from './modules/world';

export type AppDependencies = {
  origin: string;
  health: HealthConfig;
  management: {
    authenticate: RequestHandler;
    characters: AICharacterRoutePort;
    providers: ProviderRouteDependencies;
    tasks: TaskPort;
  };
  audio: Omit<AudioRouteDependencies, 'origin'>;
  world: {
    roomId: () => string;
    presence: () => WorldPresence | undefined;
  };
  chat: {
    getChat: Parameters<typeof installChatRoutes>[1];
    speech: AudioRouteDependencies['speech'];
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
      installAICharacterRoutes(app, deps.management.characters, commands);
      installProviderRoutes(app, deps.management.providers, commands);
      installTaskRoutes(app, deps.management.tasks, commands);
    },
  });
  installAudioRoutes(app, { ...deps.audio, origin: deps.origin });
  installWorldRoutes(app, deps.world.roomId);
  installChatRoutes(
    app,
    deps.chat.getChat,
    deps.chat.speech,
    deps.chat.getAgentSpeech,
    deps.origin,
    deps.audio.asrSettings,
  );
  installPresenceRoutes(app, deps.world.presence, deps.origin);
  app.use(errorHandler());
  return app;
}
