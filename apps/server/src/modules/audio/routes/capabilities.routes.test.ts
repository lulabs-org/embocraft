import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BAILIAN_ASR, DEFAULT_WHISPER_ASR } from '@voxel/shared';
import { AsrSettingsStore } from '../persistence/asr-settings-store';
import { LocalSpeech } from '../services/asr/local-speech.service';
import { PiperModels } from '../services/tts/piper-models.service';
import { installCapabilitiesRoutes } from './capabilities.routes';

describe('audio capabilities HTTP boundary', () => {
  let server: Server, url: string, store: AsrSettingsStore, dir: string;
  const status = vi.fn();
  const origin = 'http://127.0.0.1:5187';
  beforeEach(async () => {
    vi.stubEnv('OLLAMA_MODEL', '');
    vi.spyOn(PiperModels.prototype, 'status').mockResolvedValue({
      available: false,
      reason: '请安装 Piper 模型。',
    });
    status.mockReset().mockResolvedValue({ available: true, reason: 'ready' });
    const speech = new LocalSpeech();
    vi.spyOn(speech, 'status').mockImplementation(status);
    dir = await mkdtemp(join(tmpdir(), 'capabilities-route-'));
    store = new AsrSettingsStore(join(dir, 'services.json'));
    await store.load();
    const app = express();
    installCapabilitiesRoutes(app, speech, store, origin);
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/voice/capabilities`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('advertises ASR, optional Ollama and TTS readiness without requiring an admin token', async () => {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      local: { available: true },
      whisperModels: expect.any(Array),
      ollamaConfigured: false,
      agentSpeech: { available: false },
    });
  });

  it('retains preflight, origin and cross-site policies after separation', async () => {
    const allowed = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: origin },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(origin);
    expect(allowed.headers.get('cache-control')).toBe('no-store');
    const rejectedHeaders: Record<string, string>[] = [
      { Origin: 'https://foreign.test' },
      { Origin: origin, 'Sec-Fetch-Site': 'cross-site' },
    ];
    for (const headers of rejectedHeaders) {
      expect((await fetch(url, { headers })).status).toBe(403);
    }
    expect(status).not.toHaveBeenCalled();
  });

  it('uses the selected Whisper profile and rejects wrong or deleted services', async () => {
    const whisper = await store.save({
      ...DEFAULT_WHISPER_ASR,
      provider: 'whisper',
      name: 'Whisper',
      threads: 2,
    });
    const cloud = await store.save({
      ...DEFAULT_BAILIAN_ASR,
      name: 'Cloud',
      apiKey: 'fixture',
    });
    expect((await fetch(`${url}?serviceId=${whisper.id}`)).status).toBe(200);
    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({ threads: 2 }),
    );
    expect((await fetch(`${url}?serviceId=${cloud.id}`)).status).toBe(400);
    await store.remove(whisper.id);
    expect((await fetch(`${url}?serviceId=${whisper.id}`)).status).toBe(404);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('keeps unexpected capability failures private', async () => {
    status.mockRejectedValueOnce(new Error('private upstream error'));
    const response = await fetch(url);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: '无法检查识别服务。' });
  });
});
