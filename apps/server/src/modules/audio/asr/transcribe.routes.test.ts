import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsrSettingsStore } from './asr-settings';
import { DEFAULT_WHISPER_ASR, DEFAULT_BAILIAN_ASR } from '@voxel/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { installTranscribeRoutes } from './transcribe.routes';
import { LocalSpeech } from './local-speech';
import { AppError } from '../../../core/errors/app-error';
describe('transcription HTTP boundary', () => {
  let server: Server, url: string, store: AsrSettingsStore, dir: string;
  const transcribe = vi.fn();
  beforeEach(async () => {
    vi.stubEnv('WEB_ORIGIN', 'http://127.0.0.1:5187');
    transcribe.mockReset().mockResolvedValue('hello');
    const speech = new LocalSpeech();
    vi.spyOn(speech, 'status').mockResolvedValue({
      available: true,
      reason: 'ready',
    });
    vi.spyOn(speech, 'transcribe').mockImplementation(transcribe);
    dir = await mkdtemp(join(tmpdir(), 'whisper-route-'));
    store = new AsrSettingsStore(join(dir, 'services.json'));
    await store.load();
    const app = express();
    installTranscribeRoutes(app, speech, store);
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it('allows the configured page preflight but rejects other origins', async () => {
    const allowed = await fetch(`${url}/voice/transcribe`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://127.0.0.1:5187' },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('Access-Control-Allow-Headers')).toBe(
      'Content-Type',
    );
    const blocked = await fetch(`${url}/voice/transcribe`, {
      method: 'POST',
      headers: { Origin: 'https://example.com', 'Content-Type': 'audio/wav' },
      body: 'test',
    });
    expect(blocked.status).toBe(403);
    expect(transcribe).not.toHaveBeenCalled();
  });
  it('passes audio to transcription and returns structured errors', async () => {
    const response = await fetch(`${url}/voice/transcribe?language=en`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: 'audio',
    });
    expect(await response.json()).toEqual({ text: 'hello' });
    expect(transcribe.mock.calls[0][0]).toEqual(Buffer.from('audio'));
    expect(transcribe.mock.calls[0][2]).toBe('en');
    transcribe.mockRejectedValueOnce(new AppError('busy', 429));
    const failed = await fetch(`${url}/voice/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: 'audio',
    });
    expect(failed.status).toBe(429);
    expect(await failed.json()).toEqual({ error: 'busy' });
  });
  it('distinguishes no-speech from inference failures for live recording clients', async () => {
    transcribe.mockRejectedValueOnce(
      new AppError('没有识别到文字，请重试。', 400, 'no-speech'),
    );
    const response = await fetch(`${url}/voice/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: 'audio',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'no-speech' });
  });
  it('rejects oversized bodies before invoking inference', async () => {
    const response = await fetch(`${url}/voice/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: new Uint8Array(5 * 1024 * 1024 + 1),
    });
    expect(response.status).toBe(413);
    expect(transcribe).not.toHaveBeenCalled();
  });
  it('routes named Whisper profiles, preserves defaults, rejects wrong or deleted services, and releases active leases', async () => {
    const a = await store.save({
      ...DEFAULT_WHISPER_ASR,
      provider: 'whisper',
      name: 'fast',
      threads: 2,
    });
    const b = await store.save({
      ...DEFAULT_WHISPER_ASR,
      provider: 'whisper',
      name: 'terms',
      threads: 8,
      beamSize: 7,
      prompt: '量子计算',
    });
    const cloud = await store.save({
      ...DEFAULT_BAILIAN_ASR,
      name: 'cloud',
      apiKey: 'test',
    });
    const send = (id?: string) =>
      fetch(
        `${url}/voice/transcribe?language=zh${id ? `&serviceId=${id}` : ''}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body: 'test audio',
        },
      );
    expect((await send(a.id)).status).toBe(200);
    expect(transcribe.mock.calls[0][4]).toMatchObject({
      threads: 2,
      beamSize: 5,
    });
    expect((await send(b.id)).status).toBe(200);
    expect(transcribe.mock.calls[1][4]).toMatchObject({
      threads: 8,
      beamSize: 7,
      prompt: '量子计算',
    });
    expect((await send()).status).toBe(200);
    expect(transcribe.mock.calls[2][4]).toBeUndefined();
    expect((await send(cloud.id)).status).toBe(400);
    expect((await send('missing')).status).toBe(404);
    expect(transcribe).toHaveBeenCalledTimes(3);
    let finish!: (s: string) => void;
    let started!: () => void;
    const starting = new Promise<void>((resolve) => {
      started = resolve;
    });
    transcribe.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const pending = send(a.id);
    await starting;
    await expect(store.remove(a.id)).rejects.toMatchObject({ status: 409 });
    finish('完成');
    expect((await pending).status).toBe(200);
    await store.remove(a.id);
    expect((await send(a.id)).status).toBe(404);
  });
});
