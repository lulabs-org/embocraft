import cors from 'cors';
import express, { type Express } from 'express';
import { env } from '../../../core/config/env';
import { AppError } from '../../../core/errors/app-error';
import { asyncRoute } from '../../../core/http/middleware/async-route';
import { errorHandler } from '../../../core/http/middleware/error-handler';
import { createOriginGuard } from '../../../core/http/middleware/origin-guard';
import { AsrSettingsStore } from '../persistence/asr-settings-store';
import { LocalSpeech } from '../services/local-speech.service';
import { scheduleSpeech } from '../services/speech-scheduler.service';
import { MAX_AUDIO_BYTES } from '../../../core/audio/normalize';
export function installTranscribeRoutes(
  app: Express,
  speech = new LocalSpeech(),
  asrSettings: AsrSettingsStore,
  origin = env.webOrigin(),
) {
  app.use(
    '/voice/transcribe',
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
   * /voice/transcribe:
   *   post:
   *     summary: 上传音频转录为文本
   *     tags:
   *       - Voice
   *     parameters:
   *       - in: query
   *         name: language
   *         schema:
   *           type: string
   *           default: zh
   *         description: 识别语言代码 (如 zh, en)
   *       - in: query
   *         name: serviceId
   *         schema:
   *           type: string
   *         description: 可选指定的 ASR 服务配置 ID
   *       - in: query
   *         name: partial
   *         schema:
   *           type: string
   *           enum: ['0', '1']
   *         description: 是否为流式/部分转录预览
   *     requestBody:
   *       required: true
   *       description: 原始音频二进制流 (Content-Type 对应 audio/wav, audio/webm 等)
   *       content:
   *         audio/*:
   *           schema:
   *             type: string
   *             format: binary
   *     responses:
   *       200:
   *         description: 识别结果文本
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 text:
   *                   type: string
   */
  app.post(
    '/voice/transcribe',
    express.raw({ type: () => true, limit: MAX_AUDIO_BYTES }),
    asyncRoute(async (req, res) => {
      const controller = new AbortController();
      const cancel = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', cancel);
      let release: (() => void) | undefined;
      try {
        const selected =
          req.query.serviceId === undefined
            ? undefined
            : asrSettings.acquire(String(req.query.serviceId));
        release = selected?.release;
        if (selected && selected.settings.provider !== 'whisper')
          throw new AppError('请选择 Whisper 服务。');
        const text = await scheduleSpeech(speech).transcribe(
          Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
          req.headers['content-type'] ?? '',
          String(req.query.language ?? 'zh'),
          controller.signal,
          req.query.partial === '1',
          selected?.settings.provider === 'whisper'
            ? selected.settings
            : undefined,
        );
        if (!controller.signal.aborted) res.json({ text });
      } catch (error) {
        if (!controller.signal.aborted)
          res.status(error instanceof AppError ? error.status : 500).json({
            code: error instanceof AppError ? error.code : undefined,
            error:
              error instanceof AppError
                ? error.message
                : '服务器识别失败，请重试。',
          });
      } finally {
        release?.();
        res.off('close', cancel);
      }
    }),
  );
  app.use(
    '/voice/transcribe',
    errorHandler((error) => ({
      status:
        error &&
        typeof error === 'object' &&
        'type' in error &&
        error.type === 'entity.too.large'
          ? 413
          : 400,
      body: { error: '无法读取音频，请使用不超过 5 MiB 的文件。' },
    })),
  );
}
