import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createTestServer } from '../../../../test/helpers/test-server';
import { TestAsrSettingsStore } from '../../../../test/helpers/memory-storage';

it('protects discovery, reuses saved keys only for the same endpoint, and never saves discovery drafts', async () => {
  const calls: string[] = [];
  const upstream = createServer((req, res) => {
    calls.push(req.headers.authorization ?? '');
    expect(req.url).toBe('/v1/models?task=automatic-speech-recognition');
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        data: [
          {
            id: 'vendor/dynamic-asr',
            task: 'automatic-speech-recognition',
            voices: [],
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
  const voices = new TestAsrSettingsStore();
  const server = await createTestServer({ asrSettings: voices });
  try {
    vi.stubEnv('SPEECH_API_URL', 'http://deployment-speech:8000/v1/');
    expect((await fetch(`${server.httpUrl}/voice/asr/defaults`)).status).toBe(
      401,
    );
    const defaults = await fetch(`${server.httpUrl}/voice/asr/defaults`, {
      headers: { Authorization: 'Bearer fixture-gateway-token-for-tests' },
    });
    expect(defaults.status).toBe(200);
    expect(defaults.headers.get('cache-control')).toBe('no-store');
    expect(await defaults.json()).toEqual({
      baseUrl: 'http://deployment-speech:8000/v1',
    });
    const saved = await voices.save({
      name: 'Private Speaches',
      provider: 'whisper',
      baseUrl,
      apiKey: 'fixture-secret',
      model: 'vendor/dynamic-asr',
      temperature: 0,
      prompt: '',
    });
    const before = await voices.persistence.load();
    const discover = (
      body: unknown,
      token = 'fixture-gateway-token-for-tests',
    ) =>
      fetch(`${server.httpUrl}/voice/asr/models`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    expect((await discover({ baseUrl }, 'invalid-token')).status).toBe(401);
    expect(calls).toEqual([]);
    const result = await discover({ serviceId: saved.id, baseUrl, apiKey: '' });
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({
      models: [
        {
          id: 'vendor/dynamic-asr',
          languages: [],
          voices: [],
        },
      ],
    });
    expect(calls).toEqual(['Bearer fixture-secret']);
    expect(
      (
        await discover({
          serviceId: saved.id,
          baseUrl: 'http://other-speech/v1',
          apiKey: '',
        })
      ).status,
    ).toBe(400);
    expect(calls).toHaveLength(1);
    expect((await discover({ baseUrl, apiKey: 'new-draft-key' })).status).toBe(
      200,
    );
    expect(calls.at(-1)).toBe('Bearer new-draft-key');
    expect(await voices.persistence.load()).toEqual(before);
    expect(JSON.stringify(voices.list())).not.toContain('fixture-secret');
  } finally {
    vi.unstubAllEnvs();
    await server.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
