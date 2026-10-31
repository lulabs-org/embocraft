import { expect, it, vi } from 'vitest';
import { DEFAULT_PIPER_MODEL } from '@voxel/shared';
import { PiperModels } from './piper-models.service';

it('reports readiness from installed models without starting downloads', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: DEFAULT_PIPER_MODEL }] })),
    );
  const models = new PiperModels('http://speech/v1', request);
  expect(await models.status()).toEqual({
    available: true,
    reason: 'Piper 本地语音已就绪。',
  });
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(
    'http://speech/v1/models?task=text-to-speech',
    expect.objectContaining({
      redirect: 'error',
      signal: expect.any(AbortSignal),
    }),
  );
  expect(request.mock.calls[0][1]?.method).toBeUndefined();
});

it('directs missing-model diagnosis to service startup', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ data: [] })));
  expect(await new PiperModels('http://speech/v1', request).status()).toEqual({
    available: false,
    reason: 'Piper 中文模型尚未就绪，请检查语音服务的启动日志。',
  });
});

it.each([
  () => Promise.reject(Error('offline')),
  () => Promise.resolve(new Response('', { status: 503 })),
  () => Promise.resolve(new Response('{}')),
])('reports unreachable or invalid readiness responses', async (request) => {
  expect(await new PiperModels('http://speech/v1', request).status()).toEqual({
    available: false,
    reason: '无法连接语音服务，请检查 speech 容器和接口地址。',
  });
});
