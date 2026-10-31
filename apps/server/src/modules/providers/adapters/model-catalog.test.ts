import { afterEach, expect, it, vi } from 'vitest';
import { ModelCatalog } from './model-catalog';
import { validateProvider } from '../domain/validation';
import { AppError } from '../../../core/errors/app-error';

const provider = (type = 'ollama', apiKey = '') =>
  validateProvider({ type, apiKey, name: 'fixture' });

afterEach(() => {
  vi.restoreAllMocks();
});

it('reads native Gemini models with header authentication and excludes embedding models', async () => {
  const saved = provider('gemini', 'fixture-secret');
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      models: [
        {
          name: 'models/gemini-flash-lite-latest',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/gemini-4-argon',
          supportedGenerationMethods: ['generateContent', 'countTokens'],
        },
        {
          name: 'models/embedding',
          supportedGenerationMethods: ['embedContent'],
        },
        {
          name: 'models/gemini-4-argon',
          supportedGenerationMethods: ['generateContent'],
        },
      ],
    }),
  );
  await expect(
    new ModelCatalog({ getRuntime: () => saved }).models(saved.id),
  ).resolves.toEqual(['gemini-4-argon', 'gemini-flash-lite-latest']);
  expect(fetchSpy).toHaveBeenCalledWith(
    'https://generativelanguage.googleapis.com/v1beta/models',
    expect.objectContaining({
      headers: { 'x-goog-api-key': 'fixture-secret' },
      redirect: 'error',
    }),
  );
});

it('requires credentials only for remote providers and preserves missing-provider errors', async () => {
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () =>
      Response.json({ data: [{ id: 'fixture-model' }] }),
    );
  const getRuntime = vi.fn(() => provider('deepseek'));
  const catalog = new ModelCatalog({ getRuntime });
  await expect(catalog.models('remote')).rejects.toMatchObject({
    status: 400,
    message: '请先配置 API Key。',
  });
  expect(fetchSpy).not.toHaveBeenCalled();
  getRuntime.mockReturnValue(provider());
  await expect(catalog.models('local')).resolves.toEqual(['fixture-model']);
  getRuntime.mockImplementation(() => {
    throw new AppError('服务不存在。', 404);
  });
  await expect(catalog.models('missing')).rejects.toMatchObject({
    status: 404,
  });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it('bounds queries per provider, allows other providers and releases successful queries', async () => {
  let finish!: (res: Response) => void;
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const catalog = new ModelCatalog({ getRuntime: () => provider() });
  const first = catalog.models('a');
  await expect(catalog.models('a')).rejects.toMatchObject({ status: 429 });
  fetchSpy.mockImplementation(async () =>
    Response.json({ data: [{ id: 'other-model' }] }),
  );
  await expect(catalog.models('b')).resolves.toEqual(['other-model']);
  finish(Response.json({ data: [{ id: 'first-model' }] }));
  await expect(first).resolves.toEqual(['first-model']);
  await expect(catalog.models('a')).resolves.toEqual(['other-model']);
});

it('hides provider failures, forwards saved configuration and releases failed queries', async () => {
  const saved = provider('deepseek', 'fixture-secret');
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(Error('fixture-secret'))
    .mockImplementation(async () =>
      Response.json({ data: [{ id: 'recovered' }] }),
    );
  const catalog = new ModelCatalog({ getRuntime: () => saved });
  await expect(catalog.models(saved.id)).rejects.toMatchObject({
    status: 502,
    message:
      '无法获取模型列表，请检查地址、密钥和服务状态。支持的模型 ID 也可手动填写。',
  });
  expect(fetchSpy).toHaveBeenCalledWith(
    'https://api.deepseek.com/models',
    expect.objectContaining({
      headers: { Authorization: 'Bearer fixture-secret' },
    }),
  );
  await expect(catalog.models(saved.id)).resolves.toEqual(['recovered']);
});

it('fetches, deduplicates and sorts model IDs using fetch', async () => {
  const saved = provider('deepseek', 'fixture-secret');
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () =>
      Response.json({ data: [{ id: 'z' }, { id: 'a' }, { id: 'a' }] }),
    );
  const catalog = new ModelCatalog({ getRuntime: () => saved });
  await expect(catalog.models(saved.id)).resolves.toEqual(['a', 'z']);
  expect(fetchSpy).toHaveBeenCalledWith(
    'https://api.deepseek.com/models',
    expect.objectContaining({
      headers: { Authorization: 'Bearer fixture-secret' },
      redirect: 'error',
    }),
  );
});
