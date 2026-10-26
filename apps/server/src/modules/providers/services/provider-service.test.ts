import { expect, it, vi } from 'vitest';
import { AppError } from '../../../common/errors';
import { toProviderView } from '../domain/model';
import { validateProvider } from '../domain/validation';
import { ProviderService } from './provider-service';

function fixture(referenced = false) {
  const view = toProviderView(
    validateProvider({ name: 'Local', type: 'ollama' }),
  );
  const store = {
    list: vi.fn(() => [view]),
    save: vi.fn(async () => view),
    remove: vi.fn(async () => {}),
  };
  const catalog = { models: vi.fn(async () => ['fixture-model']) };
  const health = {
    check: vi.fn(async () => ({ reachable: true, modelsAvailable: true })),
  };
  const hasCharacterReference = vi.fn(() => referenced);
  const changed = vi.fn();
  return {
    service: new ProviderService(
      store,
      catalog,
      hasCharacterReference,
      changed,
      health,
    ),
    store,
    catalog,
    health,
    hasCharacterReference,
    changed,
    view,
  };
}

it('delegates reads and publishes one change after each saved provider', async () => {
  const { service, store, catalog, health, changed, view } = fixture();
  const input = { name: 'Updated', type: 'ollama' };

  expect(service.list()).toEqual([view]);
  await expect(service.models('ollama')).resolves.toEqual(['fixture-model']);
  expect(catalog.models).toHaveBeenCalledWith('ollama');
  await expect(service.health('ollama')).resolves.toEqual({
    reachable: true,
    modelsAvailable: true,
  });
  expect(health.check).toHaveBeenCalledWith('ollama');
  await expect(service.save(input, 'ollama')).resolves.toEqual(view);
  expect(store.save).toHaveBeenCalledWith(input, 'ollama');
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledWith({
    type: 'providers.changed',
    providerId: view.id,
  });
});

it('removes an unreferenced provider and publishes one change', async () => {
  const { service, store, hasCharacterReference, changed } = fixture();

  await service.remove('ollama');

  expect(hasCharacterReference).toHaveBeenCalledWith('ollama');
  expect(store.remove).toHaveBeenCalledWith('ollama');
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledWith({
    type: 'providers.changed',
    providerId: 'ollama',
  });
});

it('preserves the reference conflict without deleting or publishing', async () => {
  const { service, store, changed } = fixture(true);

  await expect(service.remove('ollama')).rejects.toMatchObject({
    status: 409,
    message: '已有可复用 Agent 关联此模型服务，请保留配置或更新其密钥。',
  });
  expect(store.remove).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it('passes through missing-provider and storage failures without publishing', async () => {
  const { service, store, changed } = fixture();
  store.remove.mockRejectedValueOnce(new AppError('模型服务不存在。', 404));
  await expect(service.remove('missing')).rejects.toMatchObject({
    status: 404,
  });
  store.remove.mockRejectedValueOnce(new Error('disk failed'));
  await expect(service.remove('ollama')).rejects.toThrow('disk failed');
  store.save.mockRejectedValueOnce(new Error('disk failed'));
  await expect(service.save({ name: 'Local' })).rejects.toThrow('disk failed');
  expect(changed).not.toHaveBeenCalled();
});
