import cors from 'cors';
import type { Router } from 'express';
import { env } from '../../../core/config/env';
import { AppError } from '../../../core/errors/app-error';
import { asyncRoute } from '../../../core/http/middleware/async-route';
import { createOriginGuard } from '../../../core/http/middleware/origin-guard';
import { createDefaultSpeechStatus } from '../../tts';
import { listSenseVoiceModels } from '../engines';
import { settingsFor, speechRouter } from '../engines/speech-router';
import { asrService } from '../services/asr.service';

export function installCapabilitiesRoutes(router: Router) {
  const origin = env.webOrigin();
  const defaultSpeechStatus = createDefaultSpeechStatus();
  router.use(
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
   *                 agentSpeech:
   *                   type: object
   */
  router.get(
    '/voice/capabilities',
    asyncRoute(async (req, res) => {
      try {
        const selected =
          req.query.serviceId === undefined
            ? undefined
            : await asrService.get(String(req.query.serviceId));
        // 云端配置不是服务器内引擎，engineFor 会直接拒绝。
        const engine = await speechRouter.engineFor(selected);
        // 已安装模型列表是全局信息，因此即使还没保存 SenseVoice 配置，
        // 控制台也能提供已安装的模型。
        const [local, senseVoiceModels] = await Promise.all([
          engine.status(settingsFor(selected)),
          listSenseVoiceModels(),
        ]);
        res.json({
          local,
          senseVoiceModels: senseVoiceModels.map((model) => model.name),
          agentSpeech: await defaultSpeechStatus(),
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
