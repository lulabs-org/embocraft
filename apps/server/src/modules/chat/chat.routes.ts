import { asyncRoute } from '../../http/middleware/async-route';
import cors from 'cors';
import { env } from '../../config/env';
import { createOriginGuard } from '../../http/middleware/origin-guard';
import { errorHandler } from '../../http/middleware/error-handler';
import express, { type Express } from 'express';
import { type WorldChat } from './chat';

import { LocalSpeech } from '../audio/asr/local-speech';
import { AppError } from '../../common/errors';
import type { AgentSpeech } from '../audio/tts/agent-speech';
import { ChatSpeechService } from './speech-service';
export function installChatRoutes(
  app: Express,
  getChat: () => WorldChat | undefined,
  speech = new LocalSpeech(),
  getAgentSpeech: () => AgentSpeech | undefined = () => undefined,
  origin = env.webOrigin(),
) {
  const speechService = new ChatSpeechService(speech);
  app.use(
    '/chat',
    createOriginGuard({
      origin,
      message: '不允许此页面访问聊天音频。',
    }),
    (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
    cors({
      origin: (requestOrigin, callback) =>
        callback(null, requestOrigin || origin),
      methods: 'GET, POST, DELETE, OPTIONS',
      allowedHeaders: 'Content-Type, Authorization',
    }),
    (req, res, next) => {
      try {
        const chat = getChat();
        if (!chat) throw new AppError('世界服务尚未就绪。', 503);
        res.locals.chat = chat;
        res.locals.actor = chat.authenticate(
          (req.headers.authorization ?? '').replace(/^Bearer /, ''),
        );
        next();
      } catch (e) {
        next(e);
      }
    },
  );
  /**
   * @openapi
   * /chat/audio:
   *   post:
   *     security:
   *       - ChatBearer: []
   *     summary: 上传并发布语音聊天消息
   *     tags:
   *       - Chat
   *     parameters:
   *       - in: query
   *         name: scope
   *         schema:
   *           type: string
   *         description: 消息作用域
   *       - in: query
   *         name: to
   *         schema:
   *           type: string
   *         description: 接收者列表 (逗号分隔)
   *       - in: query
   *         name: language
   *         schema:
   *           type: string
   *           default: zh
   *     requestBody:
   *       required: true
   *       content:
   *         audio/*:
   *           schema:
   *             type: string
   *             format: binary
   *     responses:
   *       201:
   *         description: 发布成功，返回消息详情
   */
  app.post(
    '/chat/audio',
    express.raw({ type: () => true, limit: '1mb' }),
    asyncRoute(async (req, res, next) => {
      const chat = res.locals.chat as WorldChat,
        actor = res.locals.actor as string;
      const route = {
        scope: req.query.scope,
        recipients:
          typeof req.query.to === 'string' && req.query.to
            ? req.query.to.split(',')
            : [],
      };
      const abort = new AbortController();
      const cancel = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.on('close', cancel);
      try {
        const data = await speechService.publishAudio({
          chat,
          actor,
          route,
          bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
          contentType: req.headers['content-type'] ?? '',
          language: req.query.language === 'en' ? 'en' : 'zh',
          token: (req.headers.authorization ?? '').replace(/^Bearer /, ''),
          signal: abort.signal,
        });
        res.status(201).json(data);
      } catch (e) {
        if (!abort.signal.aborted) next(e);
      } finally {
        res.off('close', cancel);
      }
    }),
  );

  /**
   * @openapi
   * /chat/spatial/start:
   *   post:
   *     security:
   *       - ChatBearer: []
   *     summary: 发起空间语音流
   *     tags:
   *       - Chat
   *     responses:
   *       200:
   *         description: 返回生成的空间语音 session id
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 id:
   *                   type: string
   */
  app.post('/chat/spatial/start', (req, res, next) => {
    try {
      res.json({
        id: (res.locals.chat as WorldChat).beginSpatial(res.locals.actor),
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * @openapi
   * /chat/spatial/{id}:
   *   delete:
   *     security:
   *       - ChatBearer: []
   *     summary: 结束空间语音流
   *     tags:
   *       - Chat
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       204:
   *         description: 已成功结束
   */
  app.delete('/chat/spatial/:id', (req, res) => {
    (res.locals.chat as WorldChat).endSpatial(
      res.locals.actor,
      String(req.params.id),
    );
    res.sendStatus(204);
  });

  /**
   * @openapi
   * /chat/spatial/{id}:
   *   post:
   *     security:
   *       - ChatBearer: []
   *     summary: 提交并发布空间语音片段
   *     tags:
   *       - Chat
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         audio/*:
   *           schema:
   *             type: string
   *             format: binary
   *     responses:
   *       200:
   *         description: 成功处理语音片段
   * /chat/spatial/{id}/preview:
   *   post:
   *     security:
   *       - ChatBearer: []
   *     summary: 实时预览空间语音转录片段
   *     tags:
   *       - Chat
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         audio/*:
   *           schema:
   *             type: string
   *             format: binary
   *     responses:
   *       200:
   *         description: 实时转录部分结果
   */
  app.post(
    ['/chat/spatial/:id', '/chat/spatial/:id/preview'],
    express.raw({ type: () => true, limit: '1mb' }),
    asyncRoute(async (req, res, next) => {
      const chat = res.locals.chat as WorldChat,
        actor = res.locals.actor as string,
        id = String(req.params.id);
      const partial = req.path.endsWith('/preview');
      const abort = new AbortController();
      const cancel = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.on('close', cancel);
      try {
        res.json(
          await speechService.transcribeSpatial({
            chat,
            actor,
            id,
            bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
            contentType: req.headers['content-type'] ?? '',
            partial,
            token: (req.headers.authorization ?? '').replace(/^Bearer /, ''),
            signal: abort.signal,
          }),
        );
      } catch (e) {
        if (!abort.signal.aborted) next(e);
      } finally {
        res.off('close', cancel);
      }
    }),
  );

  /**
   * @openapi
   * /chat/agent-speech/{id}:
   *   get:
   *     security:
   *       - ChatBearer: []
   *     summary: 获取 Agent 语音音频 (WAV)
   *     tags:
   *       - Chat
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: WAV 格式音频
   *         content:
   *           audio/wav:
   *             schema:
   *               type: string
   *               format: binary
   */
  app.get('/chat/agent-speech/:id', (req, res, next) => {
    try {
      const service = getAgentSpeech();
      if (!service) throw new AppError('Agent 语音服务未就绪。', 503);
      res
        .type('audio/wav')
        .send(service.audio(String(req.params.id), res.locals.actor));
    } catch (e) {
      next(e);
    }
  });

  /**
   * @openapi
   * /chat/audio/{id}:
   *   get:
   *     security:
   *       - ChatBearer: []
   *     summary: 获取聊天语音音频 (WAV)
   *     tags:
   *       - Chat
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: WAV 格式音频
   *         content:
   *           audio/wav:
   *             schema:
   *               type: string
   *               format: binary
   */
  app.get('/chat/audio/:id', (req, res, next) => {
    try {
      res
        .type('audio/wav')
        .send(
          (res.locals.chat as WorldChat).audio(
            String(req.params.id),
            res.locals.actor,
          ),
        );
    } catch (e) {
      next(e);
    }
  });
  app.use(
    '/chat',
    errorHandler((e) => ({
      status:
        e instanceof AppError
          ? e.status
          : e &&
              typeof e === 'object' &&
              'type' in e &&
              e.type === 'entity.too.large'
            ? 413
            : 400,
      body: {
        code: e instanceof AppError ? e.code : undefined,
        error:
          e instanceof AppError ? e.message : '无法处理语音消息，请检查输入。',
      },
    })),
  );
}
