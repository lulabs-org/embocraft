import express, { type Router, type RequestHandler } from 'express';
import { createManagementRouter } from '../../../core/http/middleware/management-policy';
import type { VoiceServiceStore } from '../services/voice-service-store';
import { installVoiceServiceRoutes } from './voice-services.routes';

export type TtsRouteDependencies = {
  authenticateManagement: RequestHandler;
  voiceServices: VoiceServiceStore;
  removeVoiceService: (id: string) => Promise<unknown>;
};

/** 创建独立的 TTS 路由 Router 实例 */
export function createTtsRouter(deps: TtsRouteDependencies): Router {
  const router = express.Router();
  router.use(
    createManagementRouter(
      '/voice/tts',
      deps.authenticateManagement,
      (management) => {
        installVoiceServiceRoutes(
          management,
          deps.voiceServices,
          deps.removeVoiceService,
        );
      },
    ),
  );
  return router;
}
