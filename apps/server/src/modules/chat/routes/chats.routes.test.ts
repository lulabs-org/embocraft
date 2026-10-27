import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { Player } from '@voxel/shared';
import { installChatRoutes } from './chats.routes';
import { WorldChat } from '../services/chat.service';
import { errorHandler } from '../../../core/http/middleware/error-handler';
import type { LocalSpeech } from '../../audio';
import type { AsrSettingsStore } from '../../audio';
import { DEFAULT_WHISPER_ASR } from '@voxel/shared';

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
});

it('publishes confirmed external recognition only with the speaker’s live ticket', async () => {
  const speaker: Player = {
    id: 'speaker',
    name: 'Speaker',
    kind: 'human',
    connected: true,
    voiceSending: true,
    x: 0,
    y: 2,
    z: 0,
    yaw: 0,
  };
  const emit = vi.fn();
  const chat = new WorldChat(() => [speaker], emit);
  const token = chat.issue('speaker');
  const origin = 'http://127.0.0.1:5173';
  const app = express();
  installChatRoutes(app, () => chat, undefined, undefined, origin);
  app.use(errorHandler());
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = {
    Origin: origin,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const start = await fetch(`${base}/chat/spatial/start`, {
    method: 'POST',
    headers,
  });
  expect(start.status).toBe(200);
  const { id } = (await start.json()) as { id: string };
  const path = `${base}/chat/spatial/${id}/text`;
  expect(
    (
      await fetch(path, {
        method: 'POST',
        headers: { ...headers, Authorization: 'Bearer bad' },
        body: JSON.stringify({ text: 'hello' }),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(path, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: '' }),
      })
    ).status,
  ).toBe(400);
  expect(emit).not.toHaveBeenCalled();
  const published = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'hello' }),
  });
  expect(published.status).toBe(200);
  expect(emit).toHaveBeenCalledWith(
    'speaker',
    expect.objectContaining({ scope: 'nearby', text: 'hello' }),
  );
  expect(
    (
      await fetch(path, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'again' }),
      })
    ).status,
  ).toBe(409);
});

it('passes the selected recognition service from a recorded chat upload to Whisper', async () => {
  const speaker: Player = {
    id: 'speaker',
    name: 'Speaker',
    kind: 'human',
    connected: true,
    voiceSending: true,
    x: 0,
    y: 2,
    z: 0,
    yaw: 0,
  };
  const chat = new WorldChat(() => [speaker], vi.fn());
  const token = chat.issue('speaker');
  const bytes = Buffer.from('audio');
  const transcribe = vi.fn().mockResolvedValue('hello');
  const speech = {
    normalize: vi.fn().mockResolvedValue({ bytes, durationMs: 1000 }),
    transcribe,
  } as unknown as LocalSpeech;
  const release = vi.fn();
  const settings = {
    ...DEFAULT_WHISPER_ASR,
    id: 'recording-whisper',
    name: 'Recording Whisper',
    provider: 'whisper' as const,
  };
  const store = {
    acquire: vi.fn(() => ({ settings, release })),
  } as unknown as AsrSettingsStore;
  const app = express();
  const origin = 'http://127.0.0.1:5173';
  installChatRoutes(app, () => chat, speech, undefined, origin, store);
  app.use(errorHandler());
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await fetch(
    `${base}/chat/audio?scope=public&language=zh&serviceId=recording-whisper`,
    {
      method: 'POST',
      headers: {
        Origin: origin,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'audio/wav',
      },
      body: bytes,
    },
  );
  expect(response.status).toBe(201);
  expect((await response.json()).transcriptAvailable).toBe(true);
  expect(store.acquire).toHaveBeenCalledWith('recording-whisper');
  expect(transcribe).toHaveBeenCalledWith(
    bytes,
    'audio/wav',
    'zh',
    expect.any(AbortSignal),
    settings,
  );
  expect(release).toHaveBeenCalledOnce();
});
