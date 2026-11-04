import express from 'express';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import {
  LiveVoiceStore,
  type SavedLiveVoice,
} from '../services/live-voice-store';
import { createLiveVoiceRouter } from './live-voice.routes';

it('protects live voice management and never returns credentials', async () => {
  let values: SavedLiveVoice[] = [];
  const store = new LiveVoiceStore({
    load: async () => values,
    save: async (next) => {
      values = structuredClone(next);
    },
  });
  await store.load();
  const app = express();
  app.use(
    createLiveVoiceRouter(store, (req, res, next) => {
      if (req.headers.authorization === 'Bearer admin') next();
      else res.sendStatus(401);
    }),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/voice/live/services`;
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'gemini',
        name: 'Live',
        model: 'gemini-3.8-live',
        voice: 'Kore',
        apiKey: 'secret',
      }),
    });
    expect(response.status).toBe(201);
    expect(JSON.stringify(await response.json())).not.toContain('secret');
    const listing = await fetch(url, {
      headers: { authorization: 'Bearer admin' },
    });
    expect(listing.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await listing.json())).not.toContain('secret');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
