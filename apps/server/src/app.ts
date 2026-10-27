import express from 'express';
import type { WorldPresence } from '@voxel/shared';
import { publicCors } from './http/cors';
import { installDocsRoutes } from './http/docs.routes';
import { installHealthRoutes, type HealthConfig } from './http/health.routes';
import {
  installManagementHttp,
  type ManagementHttpDependencies,
} from './http/management';
import { errorHandler } from './http/middleware/error-handler';
import {
  installAudioRoutes,
  type AudioRouteDependencies,
} from './modules/audio/routes';
import { installChatRoutes } from './modules/chat/chat.routes';
import {
  installWorldRoutes,
  installPresenceRoutes,
} from './modules/world/world.routes';

export type AppDependencies = {
  origin: string;
  health: HealthConfig;
  management: ManagementHttpDependencies;
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
  installManagementHttp(app, deps.management);
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
