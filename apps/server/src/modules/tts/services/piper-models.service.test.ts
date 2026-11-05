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

it.each([
  { id: DEFAULT_PIPER_MODEL },
  { id: DEFAULT_PIPER_MODEL, task: 'text-to-speech' },
  { id: DEFAULT_PIPER_MODEL, task: 'automatic-speech-recognition' },
  {
    id: DEFAULT_PIPER_MODEL,
    task: null,
    voices: 'invalid',
    language: { malformed: true },
  },
])('checks readiness using only the model ID for $task', async (model) => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ data: [model] }));
  await expect(
    new PiperModels('http://speech/v1', request).status(),
  ).resolves.toEqual({
    available: true,
    reason: 'Piper 本地语音已就绪。',
  });
});

it('continues to accept a UTF-8 BOM in a model list', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        '\uFEFF' + JSON.stringify({ data: [{ id: DEFAULT_PIPER_MODEL }] }),
      ),
    );
  await expect(
    new PiperModels('http://speech/v1', request).status(),
  ).resolves.toMatchObject({ available: true });
});

it('stops and releases an oversized response without exposing its body', async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel,
    }),
  );
  const request = vi.fn<typeof fetch>().mockResolvedValue(response);
  await expect(
    new PiperModels('http://speech/v1', request).status(),
  ).resolves.toEqual({
    available: false,
    reason: '无法连接语音服务，请检查 speech 容器和接口地址。',
  });
  expect(cancel).toHaveBeenCalledOnce();
});

it('releases a failed HTTP response and preserves the unavailable message', async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), {
    status: 503,
  });
  const request = vi.fn<typeof fetch>().mockResolvedValue(response);
  await expect(
    new PiperModels('http://speech/v1', request).status(),
  ).resolves.toEqual({
    available: false,
    reason: '无法连接语音服务，请检查 speech 容器和接口地址。',
  });
  expect(cancel).toHaveBeenCalledOnce();
});

it('maps a timed-out model request to the existing unavailable message', async () => {
  const controller = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(controller.signal);
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async (_url, init) => {
      await new Promise<void>((_resolve, reject) => {
        init!.signal!.addEventListener(
          'abort',
          () => reject(init!.signal!.reason),
          { once: true },
        );
      });
      throw new Error('unexpected');
    });
  try {
    const status = new PiperModels('http://speech/v1', request).status();
    controller.abort();
    await expect(status).resolves.toEqual({
      available: false,
      reason: '无法连接语音服务，请检查 speech 容器和接口地址。',
    });
    expect(timeout).toHaveBeenCalledWith(5000);
  } finally {
    timeout.mockRestore();
  }
});
