import type { Express, RequestHandler } from 'express';
import type { AsrSettingsStore } from '../persistence/asr-settings-store';
import type { SpeechRouter } from '../services/speech-router.service';
import { installAsrRoutes } from './asr.routes';
import { installTranscribeRoutes } from './transcribe.routes';
import { installCapabilitiesRoutes } from './capabilities.routes';

export type AsrRouteDependencies = {
  origin: string;
  authenticateManagement: RequestHandler;
  /** Whisper, local SenseVoice and the engine used when no service is selected. */
  speech: SpeechRouter;
  asrSettings: AsrSettingsStore;
};

/** ASR HTTP composition; stores and cross-domain operations belong to the caller. */
export function installAsrHttp(app: Express, deps: AsrRouteDependencies) {
  app.use(
    ['/voice/asr/services', '/voice/asr/defaults', '/voice/asr/models'],
    deps.authenticateManagement,
  );
  app.use('/voice/asr/assignments', (req, res, next) => {
    if (req.method === 'GET') next();
    else deps.authenticateManagement(req, res, next);
  });

  installCapabilitiesRoutes(app, deps.speech, deps.asrSettings, deps.origin);
  installTranscribeRoutes(app, deps.speech, deps.asrSettings, deps.origin);
  installAsrRoutes(app, deps.asrSettings, deps.origin, true);
}
