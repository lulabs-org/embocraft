import { DEFAULT_PIPER_MODEL } from '@voxel/shared';
import express from 'express';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';

vi.mock('../src/modules/asr/engines', () => ({
  localSpeech: {
    status: async () => ({ available: true, reason: 'ASR ready' }),
  },
}));
vi.mock('../src/modules/asr/services/asr.service', () => ({ asrService: {} }));

import { installCapabilitiesRoutes } from '../src/modules/asr/routes/capabilities.routes';

it.each([
  [
    () =>
      Response.json({
        data: [{ id: DEFAULT_PIPER_MODEL, task: 'other', voices: 'bad' }],
      }),
    { available: true, reason: 'Piper 本地语音已就绪。' },
  ],
  [
    () => Response.json({ data: [] }),
    {
      available: false,
      reason: 'Piper 中文模型尚未就绪，请检查语音服务的启动日志。',
    },
  ],
  [
    () => Response.json({ unexpected: 'private' }),
    {
      available: false,
      reason: '无法连接语音服务，请检查 speech 容器和接口地址。',
    },
  ],
  [
    () => new Response('x'.repeat(1024 * 1024 + 1)),
    {
      available: false,
      reason: '无法连接语音服务，请检查 speech 容器和接口地址。',
    },
  ],
])(
  'keeps the capabilities TTS status contract for the default endpoint',
  async (response, expected) => {
    const realFetch = globalThis.fetch;
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response());
    vi.stubGlobal('fetch', request);
    vi.stubEnv('SPEECH_API_URL', 'http://default-speech:8000/v1');
    const app = express();
    installCapabilitiesRoutes(app);
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const result = await realFetch(
        `http://127.0.0.1:${(server.address() as { port: number }).port}/voice/capabilities`,
      );
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({
        local: { available: true, reason: 'ASR ready' },
        agentSpeech: expected,
      });
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0][0]).toBe(
        'http://default-speech:8000/v1/models?task=text-to-speech',
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  },
);
