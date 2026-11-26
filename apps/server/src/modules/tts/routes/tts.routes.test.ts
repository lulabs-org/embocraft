import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createTestServer } from '../../../../test/helpers/test-server';

it('protects discovery, reuses saved keys only for the same endpoint, and never saves discovery drafts', async () => {
  const calls: string[] = [];
  const upstream = createServer((req, res) => {
    calls.push(req.headers.authorization ?? '');
    expect(req.url).toBe('/v1/models?task=text-to-speech');
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        data: [
          {
            id: 'vendor/dynamic-tts',
            task: 'text-to-speech',
            voices: [{ id: 'speaker:2', name: 'Two' }],
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
  const server = await createTestServer();
  const voices = server.voiceServices;
  try {
    vi.stubEnv('SPEECH_API_URL', 'http://deployment-speech:8000/v1/');
    expect((await fetch(`${server.httpUrl}/voice/tts/defaults`)).status).toBe(
      401,
    );
    const defaults = await fetch(`${server.httpUrl}/voice/tts/defaults`, {
      headers: { Authorization: 'Bearer fixture-gateway-token-for-tests' },
    });
    expect(defaults.status).toBe(200);
    expect(defaults.headers.get('cache-control')).toBe('no-store');
    expect(await defaults.json()).toEqual({
      baseUrl: 'http://deployment-speech:8000/v1',
    });
    const saved = await voices.save({
      name: 'Private Speaches',
      type: 'speaches',
      baseUrl,
      apiKey: 'fixture-secret',
      model: 'vendor/dynamic-tts',
      voice: 'speaker:2',
    });
    const before = await voices.list();
    const discover = (
      body: unknown,
      token = 'fixture-gateway-token-for-tests',
    ) =>
      fetch(`${server.httpUrl}/voice/tts/models`, {
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
          id: 'vendor/dynamic-tts',
          languages: [],
          voices: [{ id: 'speaker:2', name: 'Two' }],
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
    expect(await voices.list()).toEqual(before);
    expect(JSON.stringify(await voices.list())).not.toContain('fixture-secret');
  } finally {
    vi.unstubAllEnvs();
    await server.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

const pcmWav = () => {
  const wav = Buffer.alloc(32044);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(32000, 40);
  for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(1000, i);
  return wav;
};

// Draft previews must behave like a saved-config preview from the provider's
// point of view: reuse a key only for the same type and endpoint, never persist,
// and reject empty text before contacting the provider.
it('previews unsaved drafts without persisting them and reuses a saved key only for the same endpoint', async () => {
  const calls: string[] = [];
  const upstream = createServer((req, res) => {
    calls.push(req.headers.authorization ?? '');
    expect(req.url).toBe('/v1/audio/speech');
    res.setHeader('Content-Type', 'audio/wav');
    res.end(pcmWav());
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
  const server = await createTestServer();
  try {
    const saved = await server.voiceServices.save({
      name: 'Local TTS',
      type: 'speaches',
      baseUrl,
      apiKey: 'fixture-secret',
      model: 'vendor/tts',
      voice: 'alpha',
    });
    const preview = (body: unknown) =>
      fetch(`${server.httpUrl}/voice/tts/preview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer fixture-gateway-token-for-tests',
        },
        body: JSON.stringify(body),
      });
    const draft = {
      type: 'speaches',
      baseUrl,
      apiKey: '',
      model: 'vendor/tts',
      voice: 'beta',
    };
    const response = await preview({
      serviceId: saved.id,
      draft,
      text: 'hello',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('audio/wav');
    expect(calls).toEqual(['Bearer fixture-secret']);
    expect(
      (await server.voiceServices.list()).find((item) => item.id === saved.id),
    ).toMatchObject({ voice: 'alpha', model: 'vendor/tts' });
    expect(
      (
        await preview({
          serviceId: saved.id,
          draft: { ...draft, baseUrl: 'http://127.0.0.1:9/v1' },
          text: 'hello',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await preview({
          draft: { ...draft, apiKey: 'draft-key' },
          text: 'hello',
        })
      ).status,
    ).toBe(200);
    expect(calls.at(-1)).toBe('Bearer draft-key');
    expect((await preview({ draft, text: '' })).status).toBe(400);
  } finally {
    await server.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
