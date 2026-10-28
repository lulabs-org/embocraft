import { DEFAULT_BAILIAN_ASR } from '@voxel/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { voiceApi } from './api';
afterEach(() => vi.unstubAllGlobals());
it('rejects malformed capabilities instead of advertising local speech readiness', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify({ local: { available: 'yes' } })),
    ),
  );
  await expect(
    voiceApi.capabilities(new AbortController().signal),
  ).rejects.toThrow('capabilities');
});
it('uses distinct ASR resource URLs, encodes IDs, and handles deletion without parsing JSON', async () => {
  const signal = new AbortController().signal;
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response('[]'))
    .mockResolvedValueOnce(new Response('{}'))
    .mockResolvedValueOnce(new Response('{}'))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', request);
  const draft = { ...DEFAULT_BAILIAN_ASR, name: 'A', apiKey: 'test-key' };
  await voiceApi.listAsrServices(signal);
  await voiceApi.saveAsrService(draft, signal);
  await voiceApi.saveAsrService({ ...draft, apiKey: '' }, signal, 'A/B');
  await voiceApi.deleteAsrService('A/B', signal);
  expect(
    request.mock.calls.map(([url, init]) => [
      url.split('/voice')[1],
      init.method,
    ]),
  ).toEqual([
    ['/asr/services', 'GET'],
    ['/asr/services', 'POST'],
    ['/asr/services/A%2FB', 'PUT'],
    ['/asr/services/A%2FB', 'DELETE'],
  ]);
  expect(request.mock.calls.every(([, init]) => init.signal === signal)).toBe(
    true,
  );
});
it('preserves readiness and cancellation at the request boundary', async () => {
  const data = {
    local: { available: false, reason: 'missing-model' },
  };
  const request = vi.fn(async () => new Response(JSON.stringify(data)));
  vi.stubGlobal('fetch', request);
  const signal = new AbortController().signal;
  await expect(voiceApi.capabilities(signal)).resolves.toEqual(data);
  expect(request).toHaveBeenCalledWith(
    expect.stringContaining('/voice/capabilities'),
    { signal },
  );
});
