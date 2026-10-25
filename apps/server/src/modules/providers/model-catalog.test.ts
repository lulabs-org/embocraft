import { expect, it, vi } from 'vitest';
import { ModelCatalog } from './model-catalog';
import { validateProvider } from './provider-validation';
import { AppError } from '../../common/errors';

const provider = (type = 'ollama', apiKey = '') =>
  validateProvider({ type, apiKey, name: 'fixture' });

it('requires credentials only for remote providers and preserves missing-provider errors', async () => {
  const query = vi.fn(async () => ['fixture-model']);
  const get = vi.fn(() => provider('deepseek'));
  const catalog = new ModelCatalog({ get }, query);
  await expect(catalog.models('remote')).rejects.toMatchObject({
    status: 400,
    message: '请先配置 API Key。',
  });
  expect(query).not.toHaveBeenCalled();
  get.mockReturnValue(provider());
  await expect(catalog.models('local')).resolves.toEqual(['fixture-model']);
  get.mockImplementation(() => {
    throw new AppError('服务不存在。', 404);
  });
  await expect(catalog.models('missing')).rejects.toMatchObject({
    status: 404,
  });
  expect(query).toHaveBeenCalledTimes(1);
});

it('bounds queries per provider, allows other providers and releases successful queries', async () => {
  let finish!: (models: string[]) => void;
  const query = vi.fn(
    () =>
      new Promise<string[]>((resolve) => {
        finish = resolve;
      }),
  );
  const catalog = new ModelCatalog({ get: () => provider() }, query);
  const first = catalog.models('a');
  await expect(catalog.models('a')).rejects.toMatchObject({ status: 429 });
  query.mockResolvedValue(['other-model']);
  await expect(catalog.models('b')).resolves.toEqual(['other-model']);
  finish(['first-model']);
  await expect(first).resolves.toEqual(['first-model']);
  await expect(catalog.models('a')).resolves.toEqual(['other-model']);
});

it('hides provider failures, forwards saved configuration and releases failed queries', async () => {
  const saved = provider('deepseek', 'fixture-secret');
  const query = vi
    .fn(async () => ['recovered'])
    .mockRejectedValueOnce(Error('fixture-secret'));
  const catalog = new ModelCatalog({ get: () => saved }, query);
  await expect(catalog.models(saved.id)).rejects.toMatchObject({
    status: 502,
    message:
      '无法获取模型列表，请检查地址、密钥和服务状态。支持的模型 ID 也可手动填写。',
  });
  expect(query).toHaveBeenCalledWith(saved);
  await expect(catalog.models(saved.id)).resolves.toEqual(['recovered']);
});

it('fetches, deduplicates and sorts model IDs using default fetch when no custom query provided', async () => {
  const saved = provider('deepseek', 'fixture-secret');
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({ data: [{ id: 'z' }, { id: 'a' }, { id: 'a' }] }),
      { headers: { 'Content-Type': 'application/json' } },
    ),
  );
  try {
    const catalog = new ModelCatalog({ get: () => saved });
    await expect(catalog.models(saved.id)).resolves.toEqual(['a', 'z']);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.deepseek.com/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer fixture-secret' },
        redirect: 'error',
      }),
    );
  } finally {
    fetchSpy.mockRestore();
  }
});
