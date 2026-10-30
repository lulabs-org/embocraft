import type { Express, RequestHandler } from 'express';
import { installManagementJsonRoutes } from '../../management';
import type { AsrSettingsStore } from '../persistence/asr-settings-store';
import type { LocalSpeech } from '../services/asr/local-speech.service';
import type { VoiceServiceStore } from '../persistence/voice-service-store';
import { installAsrRoutes } from './asr.routes';
import { installTranscribeRoutes } from './transcribe.routes';
import { installCapabilitiesRoutes } from './capabilities.routes';
import { installVoiceServiceRoutes } from './voice-services.routes';

export type AudioRouteDependencies = {
  origin: string;
  authenticateManagement: RequestHandler;
  speech: LocalSpeech;
  asrSettings: AsrSettingsStore;
  voiceServices: VoiceServiceStore;
  removeVoiceService: (id: string) => Promise<unknown>;
};

/** Audio HTTP composition; stores and cross-domain operations belong to the caller. */
export function installAudioRoutes(app: Express, deps: AudioRouteDependencies) {
  app.use('/voice/asr/services', deps.authenticateManagement);
  app.use('/voice/asr/assignments', (req, res, next) => {
    if (req.method === 'GET') next();
    else deps.authenticateManagement(req, res, next);
  });

  installCapabilitiesRoutes(app, deps.speech, deps.asrSettings, deps.origin);
  installTranscribeRoutes(app, deps.speech, deps.asrSettings, deps.origin);
  installAsrRoutes(app, deps.asrSettings, deps.origin, true);
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
