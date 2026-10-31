import type { Express, RequestHandler } from 'express';
import { installManagementJsonRoutes } from '../../management';
import type { VoiceServiceStore } from '../persistence/voice-service-store';
import { installVoiceServiceRoutes } from './voice-services.routes';

export type TtsRouteDependencies = {
  authenticateManagement: RequestHandler;
  voiceServices: VoiceServiceStore;
  removeVoiceService: (id: string) => Promise<unknown>;
};

/** TTS HTTP composition; Agent voice bindings are checked by the injected callback. */
export function installTtsHttp(app: Express, deps: TtsRouteDependencies) {
  installManagementJsonRoutes(
    app,
    '/voice/tts',
    deps.authenticateManagement,
    () => {
      installVoiceServiceRoutes(
        app,
        () => deps.voiceServices,
        deps.removeVoiceService,
      );
    },
  );
}
