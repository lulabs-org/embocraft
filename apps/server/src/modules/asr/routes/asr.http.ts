import express, { type Router, type RequestHandler } from 'express';
import type { AsrSettingsStore } from '../services/asr-settings-store';
import type { WhisperAdapter as LocalSpeech } from '../engines';
import { PiperModels } from '../../tts';
import { installAsrRoutes } from './asr.routes';
import { installTranscribeRoutes } from './transcribe.routes';
import {
  installCapabilitiesRoutes,
  type TtsStatusQuery,
} from './capabilities.routes';

export type AsrRouteDependencies = {
  origin: string;
  authenticateManagement: RequestHandler;
  speech: LocalSpeech;
  asrSettings: AsrSettingsStore;
  ttsStatus?: TtsStatusQuery;
};

/** 创建独立的 ASR 路由 Router 实例 */
export function createAsrRouter(deps: AsrRouteDependencies): Router {
  const router = express.Router();
  router.use(
    ['/voice/asr/services', '/voice/asr/defaults', '/voice/asr/models'],
    deps.authenticateManagement,
  );
  router.use('/voice/asr/assignments', (req, res, next) => {
    if (req.method === 'GET') next();
    else deps.authenticateManagement(req, res, next);
  });

  const ttsStatus = deps.ttsStatus ?? (() => new PiperModels().status());
  installCapabilitiesRoutes(
    router,
    deps.speech,
    deps.asrSettings,
    ttsStatus,
    deps.origin,
  );
  installTranscribeRoutes(router, deps.speech, deps.asrSettings, deps.origin);
  installAsrRoutes(router, deps.asrSettings, deps.origin, true);
  return router;
}
