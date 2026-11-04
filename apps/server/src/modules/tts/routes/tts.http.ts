import type { Express, RequestHandler } from 'express';
import { createManagementRouter } from '../../../core/http/middleware/management-policy';
import type { VoiceServiceStore } from '../persistence/voice-service-store';
import { installVoiceServiceRoutes } from './voice-services.routes';

export type TtsRouteDependencies = {
  authenticateManagement: RequestHandler;
  voiceServices: VoiceServiceStore;
  removeVoiceService: (id: string) => Promise<unknown>;
};

/** TTS HTTP composition; Agent voice bindings are checked by the injected callback. */
export function installTtsHttp(app: Express, deps: TtsRouteDependencies) {
  app.use(
    createManagementRouter(
      '/voice/tts',
      deps.authenticateManagement,
      (router) => {
        installVoiceServiceRoutes(
          router,
          () => deps.voiceServices,
          deps.removeVoiceService,
        );
      },
    ),
  );
}
