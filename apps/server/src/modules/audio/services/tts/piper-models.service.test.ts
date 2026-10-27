import { afterEach, expect, it, vi } from 'vitest';

import { PiperModels } from './piper-models.service';

import { DEFAULT_PIPER_MODEL, PIPER_MODELS } from '@voxel/shared';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const json = (data: unknown) => new Response(JSON.stringify(data));

const catalog = (installed = false) =>
  json({ data: installed ? [{ id: DEFAULT_PIPER_MODEL }] : [] });

it('deduplicates installs, rejects other models, and verifies cache after download', async () => {
  let installed = false;
  let finish!: () => void;
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'POST') {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      installed = true;
      return new Response(null);
    }
    return catalog(installed);
  });
  const models = new PiperModels('http://speech/v1', request);
  expect((await models.list())[0].state).toBe('missing');
  models.start(DEFAULT_PIPER_MODEL);
  models.start(DEFAULT_PIPER_MODEL);
  expect(() => models.start(PIPER_MODELS[1].id)).toThrow('另一个');
  expect(() => models.start('other/model')).toThrow('支持');
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect((await models.list())[0].state).toBe('installing');
  finish();
  await vi.waitFor(async () =>
    expect((await models.list())[0].state).toBe('installed'),
  );
  expect(
    request.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(1);
  expect(
    (await new PiperModels('http://speech/v1', request).list())[0].state,
  ).toBe('installed');
});

it('does not treat a successful download response as proof of installation; retries failures', async () => {
  let installed = false;
  const request = vi.fn<typeof fetch>(async (_url, init) =>
    init?.method === 'POST' ? new Response(null) : catalog(installed),
  );
  const models = new PiperModels('http://speech/v1', request);
  models.start(DEFAULT_PIPER_MODEL);
  await vi.waitFor(async () =>
    expect((await models.list())[0].state).toBe('failed'),
  );
  installed = true;
  models.start(DEFAULT_PIPER_MODEL);
  await vi.waitFor(async () =>
    expect((await models.list())[0].state).toBe('installed'),
  );
});

it('bounds installation waiting and makes failure retryable', async () => {
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== 'POST') return catalog();
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener(
        'abort',
        () => reject(init.signal?.reason),
        { once: true },
      );
    });
  });
  const models = new PiperModels('http://speech/v1', request, 20);
  models.start(DEFAULT_PIPER_MODEL);
  await vi.waitFor(async () =>
    expect((await models.list())[0]).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('超时'),
    }),
  );
});
