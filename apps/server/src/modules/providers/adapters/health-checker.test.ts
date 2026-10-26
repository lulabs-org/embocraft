import { expect, it, vi } from 'vitest';
import { AppError } from '../../../common/errors';
import { validateProvider } from '../domain/model';
import { ProviderHealthChecker } from './health-checker';

it('preserves missing-provider and missing-credential errors without probing', async () => {
  const getModels = vi.fn();
  const missing = new ProviderHealthChecker(
    {
      getRuntime: () => {
        throw new AppError('模型服务不存在。', 404);
      },
    },
    { getModels },
  );
  await expect(missing.check('missing')).rejects.toMatchObject({ status: 404 });

  const unconfigured = new ProviderHealthChecker(
    {
      getRuntime: () => validateProvider({ name: 'Remote', type: 'deepseek' }),
    },
    { getModels },
  );
  await expect(unconfigured.check('remote')).rejects.toMatchObject({
    status: 400,
    message: '请先配置 API Key。',
  });
  expect(getModels).not.toHaveBeenCalled();
});

it('separates network reachability from model-list support', async () => {
  const saved = validateProvider({ name: 'Local', type: 'ollama' });
  const getModels = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: [] }))
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockRejectedValueOnce(new Error('connection refused'));
  const checker = new ProviderHealthChecker(
    { getRuntime: () => saved },
    { getModels },
  );

  await expect(checker.check(saved.id)).resolves.toEqual({
    reachable: true,
    modelsAvailable: true,
  });
  await expect(checker.check(saved.id)).resolves.toEqual({
    reachable: true,
    modelsAvailable: false,
  });
  await expect(checker.check(saved.id)).resolves.toEqual({
    reachable: false,
    modelsAvailable: false,
  });
  expect(getModels).toHaveBeenCalledTimes(3);
  expect(getModels).toHaveBeenCalledWith(saved);
});
