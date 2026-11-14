import type { Player } from '@voxel/shared';
import { DEFAULT_WHISPER_ASR } from '@voxel/shared';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { TestAsrService } from '../../../../test/helpers/memory-storage';
import { errorHandler } from '../../../core/http/middleware/error-handler';
import type { AsrService, WhisperAdapter } from '../../asr';

const mocked = vi.hoisted(() => ({
  speech: undefined as unknown as WhisperAdapter,
  asrService: undefined as unknown as AsrService,
}));

vi.mock('../../asr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../asr')>();
  return {
    ...actual,
    whisperAdapter: {
      normalize: (...args: Parameters<WhisperAdapter['normalize']>) =>
        (mocked.speech ?? actual.whisperAdapter).normalize(...args),
      transcribe: (...args: Parameters<WhisperAdapter['transcribe']>) =>
        (mocked.speech ?? actual.whisperAdapter).transcribe(...args),
    },
    asrService: {
      acquire: (id: string) =>
        (mocked.asrService ?? new TestAsrService()).acquire(id),
    },
  };
});

import { WorldChat } from '../services/chat.service';
import type { ChatRoutePort } from '../ports';
import { createChatRouter } from './chats.routes';

let server: Server | undefined;

afterEach(async () => {
  mocked.speech = undefined as unknown as WhisperAdapter;
  mocked.asrService = undefined as unknown as AsrService;
  vi.unstubAllEnvs();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
});

it('resolves the current world per request and keeps its credentials and speech clips together', async () => {
  const speaker: Player = {
    id: 'speaker',
    name: 'Speaker',
    kind: 'human',
    connected: true,
    x: 0,
    y: 2,
    z: 0,
    yaw: 0,
  };
  const first = new WorldChat(() => [speaker], vi.fn());
  const second = new WorldChat(() => [speaker], vi.fn());
  const firstToken = first.issue(speaker.id);
  const secondToken = second.issue(speaker.id);
  const firstAudio = vi.fn(() => Buffer.from('first'));
  const secondAudio = vi.fn(() => Buffer.from('second'));
  let runtime: ChatRoutePort | undefined;
  const origin = 'http://127.0.0.1:5173';
  vi.stubEnv('WEB_ORIGIN', origin);
  const app = express();
  app.use(createChatRouter(() => runtime));
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const audio = (token: string) =>
    fetch(`${base}/chat/agent-speech/clip`, {
      headers: { Origin: origin, Authorization: `Bearer ${token}` },
    });
  expect((await audio(firstToken)).status).toBe(503);
  runtime = { chat: first, agentSpeech: { audio: firstAudio } };
  expect(await (await audio(firstToken)).text()).toBe('first');
  runtime = { chat: second, agentSpeech: { audio: secondAudio } };
  expect((await audio(firstToken)).status).toBe(401);
  expect(secondAudio).not.toHaveBeenCalled();
  expect(await (await audio(secondToken)).text()).toBe('second');
  expect(firstAudio).toHaveBeenCalledExactlyOnceWith('clip', speaker.id);
  expect(secondAudio).toHaveBeenCalledExactlyOnceWith('clip', speaker.id);
  runtime = undefined;
  expect((await audio(secondToken)).status).toBe(503);
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
  vi.stubEnv('WEB_ORIGIN', origin);
  mocked.asrService = new TestAsrService();
  const app = express();
  app.use(createChatRouter(() => ({ chat })));
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
  } as unknown as WhisperAdapter;
  const release = vi.fn();
  const settings = {
    ...DEFAULT_WHISPER_ASR,
    id: 'recording-whisper',
    name: 'Recording Whisper',
    provider: 'whisper' as const,
  };
  const store = {
    acquire: vi.fn(() => ({ settings, release })),
  } as unknown as AsrService;
  mocked.speech = speech;
  mocked.asrService = store;
  const app = express();
  const origin = 'http://127.0.0.1:5173';
  vi.stubEnv('WEB_ORIGIN', origin);
  app.use(createChatRouter(() => ({ chat })));
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
