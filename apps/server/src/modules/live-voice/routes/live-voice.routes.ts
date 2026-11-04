import express, { type RequestHandler, type Router } from 'express';
import { createManagementRouter } from '../../../core/http/middleware/management-policy';
import { asyncRoute } from '../../../core/http/middleware/async-route';
import type { LiveVoiceStore } from '../services/live-voice-store';

/** Management-only service configuration; returned views never include API keys. */
export function createLiveVoiceRouter(
  store: LiveVoiceStore,
  authenticate: RequestHandler,
): Router {
  const root = express.Router();
  root.use(
    createManagementRouter('/voice/live', authenticate, (router) => {
      /**
       * @openapi
       * /voice/live/services:
       *   get:
       *     summary: List configured live voice services
       *     tags: [Live voice]
       *     security:
       *       - ManagementBearer: []
       *     responses:
       *       200:
       *         description: Redacted live voice service configurations
       *   post:
       *     summary: Create a live voice service
       *     tags: [Live voice]
       *     security:
       *       - ManagementBearer: []
       *     responses:
       *       201:
       *         description: Service created
       * /voice/live/services/{id}:
       *   put:
       *     summary: Update a live voice service
       *     tags: [Live voice]
       *     security:
       *       - ManagementBearer: []
       *     parameters:
       *       - in: path
       *         name: id
       *         required: true
       *         schema:
       *           type: string
       *     responses:
       *       200:
       *         description: Service updated
       *   delete:
       *     summary: Delete a live voice service
       *     tags: [Live voice]
       *     security:
       *       - ManagementBearer: []
       *     parameters:
       *       - in: path
       *         name: id
       *         required: true
       *         schema:
       *           type: string
       *     responses:
       *       204:
       *         description: Service deleted
       */
      router.get(
        '/voice/live/services',
        asyncRoute((_req, res) => {
          res.setHeader('Cache-Control', 'no-store');
          res.json(store.list());
        }),
      );
      router.post(
        '/voice/live/services',
        asyncRoute(async (req, res) =>
          res.status(201).json(await store.save(req.body)),
        ),
      );
      router.put(
        '/voice/live/services/:id',
        asyncRoute(async (req, res) =>
          res.json(await store.save(req.body, req.params.id)),
        ),
      );
      router.delete(
        '/voice/live/services/:id',
        asyncRoute(async (req, res) => {
          await store.remove(req.params.id);
          res.status(204).end();
        }),
      );
    }),
  );
  return root;
}
