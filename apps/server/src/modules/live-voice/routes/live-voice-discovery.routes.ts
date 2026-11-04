import express from 'express';
import cors from 'cors';
import type { AICharacterView } from '@voxel/shared';
import { createOriginGuard } from '../../../core/http/middleware/origin-guard';
import { asyncRoute } from '../../../core/http/middleware/async-route';
import { AppError } from '../../../core/errors/app-error';
import type { WorldRoom } from '../../world';
import { authorizeWorldLiveVoice } from '../services/world-live-voice';

/** Only the current player can discover eligible nearby live Agents. */
export function createLiveVoiceDiscovery(
  getWorld: () => WorldRoom | undefined,
  characters: () => AICharacterView[],
  origin: string,
) {
  const router = express.Router();
  router.use(
    '/chat/live/agents',
    createOriginGuard({ origin }),
    cors({
      origin: true,
      methods: 'GET, OPTIONS',
      allowedHeaders: 'Authorization',
    }),
  );
  /**
   * @openapi
   * /chat/live/agents:
   *   get:
   *     summary: List nearby Agents available for live voice conversation
   *     tags: [Live voice]
   *     security:
   *       - ChatBearer: []
   *     responses:
   *       200:
   *         description: Eligible Agent session IDs and names
   */
  router.get(
    '/chat/live/agents',
    asyncRoute((req, res) => {
      const world = getWorld();
      if (!world) throw new AppError('世界尚未连接。', 503);
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      world.chat.authenticate(token);
      const available = characters().flatMap((character) => {
        if (!character.sessionId || !character.liveVoiceServiceId) return [];
        try {
          authorizeWorldLiveVoice(
            getWorld,
            characters,
            token,
            character.sessionId,
          );
          return [{ id: character.sessionId, name: character.name }];
        } catch {
          return [];
        }
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(available);
    }),
  );
  return router;
}
