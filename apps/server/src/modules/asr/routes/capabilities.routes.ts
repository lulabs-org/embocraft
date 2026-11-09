import cors from 'cors';
import type { Express } from 'express';
import { env } from '../../../core/config/env';
import { AppError } from '../../../core/errors/app-error';
import { asyncRoute } from '../../../core/http/middleware/async-route';
import { createOriginGuard } from '../../../core/http/middleware/origin-guard';
import { AsrSettingsStore } from '../persistence/asr-settings-store';
import {
  settingsFor,
  speechRouter,
  type SpeechRouter,
} from '../services/speech-router.service';
import { listSenseVoiceModels } from '../services/sense-voice-models';
import { PiperModels } from '../../tts';
export function installCapabilitiesRoutes(
  app: Express,
  router: SpeechRouter = speechRouter(),
  asrSettings: AsrSettingsStore,
  origin = env.webOrigin(),
) {
  app.use(
    '/voice/capabilities',
    createOriginGuard({
      origin,
      required: false,
      crossSite: true,
      message: '不允许此页面访问服务器语音服务。',
    }),
    (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
    cors({
      origin: true,
      allowedHeaders: 'Content-Type',
      methods: 'GET, POST, OPTIONS',
    }),
  );

  /**
   * @openapi
   * /voice/capabilities:
   *   get:
   *     summary: 查询当前语音能力与可用模型
   *     tags:
   *       - Voice
   *     parameters:
   *       - in: query
   *         name: serviceId
   *         required: false
   *         schema:
   *           type: string
   *         description: 可选的 ASR 服务 ID
   *     responses:
   *       200:
   *         description: 语音服务支持能力
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 local:
   *                   type: object
   *                 senseVoiceModels:
   *                   type: array
   *                   items:
   *                     type: string
   *                 agentSpeech:
   *                   type: object
   */
  app.get(
    '/voice/capabilities',
    asyncRoute(async (req, res) => {
      try {
        const selected =
          req.query.serviceId === undefined
            ? undefined
            : asrSettings.get(String(req.query.serviceId));
        // Cloud profiles are not a server engine, so engineFor rejects them.
        const engine = router.engineFor(selected);
        const [local, senseVoiceModels] = await Promise.all([
          engine.status(settingsFor(selected)),
          listSenseVoiceModels(),
        ]);
        res.json({
          local,
          senseVoiceModels: senseVoiceModels.map((model) => model.name),
          agentSpeech: await new PiperModels().status(),
        });
      } catch (error) {
        res.status(error instanceof AppError ? error.status : 500).json({
          error:
            error instanceof AppError ? error.message : '无法检查识别服务。',
        });
      }
    }),
  );
}
