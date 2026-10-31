import { afterEach, expect, it, vi } from 'vitest';
import { SpeachesModels } from './speaches-models.service';

afterEach(() => vi.unstubAllEnvs());

it('queries and filters recognition models independently from synthesis models', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      data: [
        {
          id: 'vendor/asr',
          task: 'automatic-speech-recognition',
          language: ['zh', 'en'],
        },
        { id: 'vendor/tts', task: 'text-to-speech' },
      ],
    }),
  );
  expect(
    await new SpeachesModels(
      { baseUrl: 'http://speech:8000/v1' },
      request,
    ).list(undefined, 'automatic-speech-recognition'),
  ).toEqual([{ id: 'vendor/asr', languages: ['zh', 'en'], voices: [] }]);
  expect(request.mock.calls[0][0]).toBe(
    'http://speech:8000/v1/models?task=automatic-speech-recognition',
  );
});

it('discovers non-Piper models and their voice IDs from the configured authenticated service', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      data: [
        { id: 'whisper', task: 'automatic-speech-recognition' },
        {
          id: 'vendor/new-tts',
          task: 'text-to-speech',
          language: ['en', 'zh'],
          voices: [
            { id: 'speaker:1', name: 'Speaker One', language: 'en' },
            { name: 'second', language: 'zh' },
          ],
        },
        { id: 'vendor/no-voices', task: 'text-to-speech', language: 'en' },
      ],
    }),
  );
  const models = await new SpeachesModels(
    { baseUrl: 'http://speaches:8000/v1/', apiKey: 'fixture-key' },
    request,
  ).list();
  expect(request).toHaveBeenCalledWith(
    'http://speaches:8000/v1/models?task=text-to-speech',
    expect.objectContaining({
      redirect: 'error',
      headers: { Authorization: 'Bearer fixture-key' },
      signal: expect.any(AbortSignal),
    }),
  );
  expect(models).toEqual([
    {
      id: 'vendor/new-tts',
      languages: ['en', 'zh'],
      voices: [
        { id: 'speaker:1', name: 'Speaker One', language: 'en' },
        { id: 'second', name: 'second', language: 'zh' },
      ],
    },
    { id: 'vendor/no-voices', languages: ['en'], voices: [] },
  ]);
});

it('uses deployment defaults and returns an empty list without inventing models', async () => {
  vi.stubEnv('SPEECH_API_URL', 'http://default:8000/v1/');
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ data: [] }));
  expect(await new SpeachesModels({}, request).list()).toEqual([]);
  expect(request.mock.calls[0][0]).toBe(
    'http://default:8000/v1/models?task=text-to-speech',
  );
  expect(request.mock.calls[0][1]?.headers).toEqual({});
});

it.each([
  () => new Response('private credentials', { status: 401 }),
  () => Response.json({ data: [{ id: null, task: 'text-to-speech' }] }),
  () =>
    Response.json({
      data: [{ id: 'tts', task: 'text-to-speech', voices: 'bad' }],
    }),
  () => Response.json({ error: 'private credentials' }),
  () => new Response('x'.repeat(1024 * 1024 + 1)),
])(
  'rejects upstream errors and malformed or oversized responses without disclosing their body',
  async (response) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response());
    await expect(new SpeachesModels({}, request).list()).rejects.toThrow(
      'Speaches',
    );
    await expect(
      new SpeachesModels(
        {},
        vi.fn<typeof fetch>().mockResolvedValue(response()),
      ).list(),
    ).rejects.not.toThrow('private credentials');
  },
);

it('does not start an aborted discovery request', async () => {
  const controller = new AbortController();
  controller.abort();
  const request = vi.fn<typeof fetch>();
  await expect(
    new SpeachesModels({}, request).list(controller.signal),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
