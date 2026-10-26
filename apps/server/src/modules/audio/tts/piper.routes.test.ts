import { afterEach, expect, it, vi } from 'vitest';

import { PiperModels } from './piper-models';

import { DEFAULT_PIPER_MODEL } from '@voxel/shared';

import { createTestServer } from '../../../../test/helpers/test-server';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const json = (data: unknown) => new Response(JSON.stringify(data));

const catalog = (installed = false) =>
  json({ data: installed ? [{ id: DEFAULT_PIPER_MODEL }] : [] });

it('keeps Piper management under the configured origin boundary and returns 202 for downloads', async () => {
  vi.stubEnv('WEB_ORIGIN', 'http://world.test');
  const models = new PiperModels(
    'http://speech/v1',
    vi.fn<typeof fetch>(async () => catalog(true)),
  );
  const server = await createTestServer({ origin: 'http://world.test' });
  vi.spyOn(server.voiceServices.piperModels, 'list').mockImplementation(() =>
    models.list(),
  );
  vi.spyOn(server.voiceServices.piperModels, 'start').mockImplementation((id) =>
    models.start(id),
  );
  const url = `${server.httpUrl}/voice/tts/piper`;
  try {
    expect(
      (
        await fetch(`${url}/models`, {
          headers: { Origin: 'http://evil.test' },
        })
      ).status,
    ).toBe(403);
    const headers = {
      Origin: 'http://world.test',
      Authorization: 'Bearer fixture-gateway-token-for-tests',
      'Content-Type': 'application/json',
    };
    expect((await fetch(`${url}/models`, { headers })).status).toBe(200);
    expect(
      (
        await fetch(`${url}/install`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: DEFAULT_PIPER_MODEL }),
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await fetch(`${url}/install`, {
          method: 'POST',
          headers,
          body: '{"model":"bad"}',
        })
      ).status,
    ).toBe(400);
  } finally {
    await server.close();
  }
});
