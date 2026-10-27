import { asyncRoute } from '../../../core/http/middleware/async-route';
import cors from 'cors';
import { env } from '../../../core/config/env';
import { createOriginGuard } from '../../../core/http/middleware/origin-guard';
import { AsrSettingsStore } from '../asr/asr-settings';
import { listWhisperModels } from '../services/asr/whisper-settings';
import type { Express } from 'express';
import { LocalSpeech } from '../services/asr/local-speech.service';
import { AppError } from '../../../core/errors/app-error';
import { createVoiceProvider } from '../services/sessions';
import { PiperModels } from '../tts/piper-models';
export function installCapabilitiesRoutes(
  app: Express,
  speech = new LocalSpeech(),
  asrSettings = new AsrSettingsStore(),
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
   *                 whisperModels:
   *                   type: array
   *                   items:
   *                     type: string
   *                 ollamaConfigured:
   *                   type: boolean
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
        if (selected && selected.provider !== 'whisper')
          throw new AppError('请选择 Whisper 服务。');
        let ollamaConfigured = false;
        try {
          createVoiceProvider('ollama');
          ollamaConfigured = true;
        } catch {
          /* Optional. */
        }
        res.json({
          local: await speech.status(selected),
          whisperModels: await listWhisperModels(),
          ollamaConfigured,
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
