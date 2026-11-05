import { afterEach, expect, it, vi } from 'vitest';
import { AppError } from '../../../core/errors/app-error';
import { domainEvents } from '../../../core/events/domain-events';
import { toProviderView } from '../domain/model';
import { validateProvider } from '../domain/validation';
import { ProviderService } from './provider.service';

afterEach(() => {
  vi.restoreAllMocks();
});

function fixture() {
  const view = toProviderView(
    validateProvider({ name: 'Local', type: 'ollama' }),
  );
  const store = {
    list: vi.fn(async () => [view]),
    save: vi.fn(async () => view),
    remove: vi.fn(async () => {}),
  };
  const catalog = { models: vi.fn(async () => ['fixture-model']) };
  const health = {
    check: vi.fn(async () => ({ reachable: true, modelsAvailable: true })),
  };
  return {
    service: new ProviderService(store, catalog, health),
    store,
    catalog,
    health,
    view,
  };
}

it('delegates reads and emits provider.changed after each saved provider', async () => {
  const { service, store, catalog, health, view } = fixture();
  const input = { name: 'Updated', type: 'ollama' };
  const changed = vi.fn();
  const off = domainEvents.on('provider.changed', changed);
  try {
    await expect(service.list()).resolves.toEqual([view]);
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
    expect(changed).toHaveBeenCalledWith({ providerId: view.id });
  } finally {
    off();
  }
});

it('removes an unreferenced provider and emits provider.removing then provider.changed', async () => {
  const { service, store } = fixture();
  const removing = vi.fn();
  const changed = vi.fn();
  const offRemoving = domainEvents.on('provider.removing', removing);
  const offChanged = domainEvents.on('provider.changed', changed);
  try {
    await service.remove('ollama');
    expect(removing).toHaveBeenCalledWith({ providerId: 'ollama' });
    expect(store.remove).toHaveBeenCalledWith('ollama');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith({ providerId: 'ollama' });
  } finally {
    offRemoving();
    offChanged();
  }
});

it('preserves the reference conflict from provider.removing without deleting or publishing', async () => {
  const { service, store } = fixture();
  const changed = vi.fn();
  const offGuard = domainEvents.on('provider.removing', () => {
    throw new AppError(
      '已有可复用 Agent 关联此模型服务，请保留配置或更新其密钥。',
      409,
    );
  });
  const offChanged = domainEvents.on('provider.changed', changed);
  try {
    await expect(service.remove('ollama')).rejects.toMatchObject({
      status: 409,
      message: '已有可复用 Agent 关联此模型服务，请保留配置或更新其密钥。',
    });
    expect(store.remove).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  } finally {
    offGuard();
    offChanged();
  }
});

it('passes through missing-provider and storage failures without publishing', async () => {
  const { service, store } = fixture();
  const changed = vi.fn();
  const off = domainEvents.on('provider.changed', changed);
  try {
    store.remove.mockRejectedValueOnce(new AppError('模型服务不存在。', 404));
    await expect(service.remove('missing')).rejects.toMatchObject({
      status: 404,
    });
    store.remove.mockRejectedValueOnce(new Error('disk failed'));
    await expect(service.remove('ollama')).rejects.toThrow('disk failed');
    store.save.mockRejectedValueOnce(new Error('disk failed'));
    await expect(service.save({ name: 'Local' })).rejects.toThrow(
      'disk failed',
    );
    expect(changed).not.toHaveBeenCalled();
  } finally {
    off();
  }
});
