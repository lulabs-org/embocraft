import { DEFAULT_BAILIAN_ASR, DEFAULT_WHISPER_ASR } from '@voxel/shared';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestAsrService } from '../../../../test/helpers/memory-storage';

const mocked = vi.hoisted(() => ({
  status: vi.fn(),
  ttsStatus: vi.fn(),
  store: undefined as unknown as TestAsrService,
}));

vi.mock('../../tts', () => ({
  createDefaultSpeechStatus: () => mocked.ttsStatus,
}));

vi.mock('../engines', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines')>();
  return {
    ...actual,
    whisperAdapter: {
      status: (...args: Parameters<typeof actual.whisperAdapter.status>) =>
        mocked.status(...args),
    },
  };
});

vi.mock('../services/asr.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/asr.service')>();
  return {
    ...actual,
    asrService: {
      get: (id: string) => mocked.store.get(id),
    },
  };
});

import { installCapabilitiesRoutes } from './capabilities.routes';

describe('audio capabilities HTTP boundary', () => {
  let server: Server, url: string, store: TestAsrService;
  const { status, ttsStatus } = mocked;
  const origin = 'http://127.0.0.1:5187';
  beforeEach(async () => {
    vi.stubEnv('WEB_ORIGIN', origin);
    ttsStatus.mockReset().mockResolvedValue({
      available: false,
      reason: '请安装 Piper 模型。',
    });
    status.mockReset().mockResolvedValue({ available: true, reason: 'ready' });
    store = new TestAsrService();
    mocked.store = store;

    const app = express();
    installCapabilitiesRoutes(app);
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/voice/capabilities`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('advertises ASR and TTS readiness without requiring an admin token', async () => {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      local: { available: true, reason: 'ready' },
      agentSpeech: { available: false, reason: '请安装 Piper 模型。' },
    });
    expect(ttsStatus).toHaveBeenCalledTimes(1);
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
    expect(ttsStatus).not.toHaveBeenCalled();
  });

  it('uses the selected Whisper profile and rejects wrong or deleted services', async () => {
    const whisper = await store.save({
      ...DEFAULT_WHISPER_ASR,
      provider: 'whisper',
      name: 'Whisper',
      model: 'Systran/faster-whisper-small',
      baseUrl: 'http://selected:8000/v1',
      apiKey: 'private-key',
    });
    const cloud = await store.save({
      ...DEFAULT_BAILIAN_ASR,
      provider: 'bailian' as const,
      name: 'Cloud',
      apiKey: 'fixture',
    });
    expect((await fetch(`${url}?serviceId=${whisper.id}`)).status).toBe(200);
    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://selected:8000/v1',
        apiKey: 'private-key',
      }),
    );
    expect((await fetch(`${url}?serviceId=${cloud.id}`)).status).toBe(400);
    await store.remove(whisper.id);
    expect((await fetch(`${url}?serviceId=${whisper.id}`)).status).toBe(404);
    expect(status).toHaveBeenCalledTimes(1);
    expect(ttsStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps unexpected capability failures private', async () => {
    status.mockRejectedValueOnce(new Error('private upstream error'));
    const response = await fetch(url);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: '无法检查识别服务。' });
    expect(ttsStatus).not.toHaveBeenCalled();
  });

  it('keeps unexpected TTS status failures private', async () => {
    ttsStatus.mockRejectedValueOnce(new Error('private TTS error'));
    const response = await fetch(url);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: '无法检查识别服务。' });
  });
});
