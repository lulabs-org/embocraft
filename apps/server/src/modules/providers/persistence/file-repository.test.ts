import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileProviderRepository } from './file-repository';
import { bootstrapProviders, createDefaultProviders } from '../bootstrap';

describe('FileProviderRepository and bootstrapProviders', () => {
  it('returns false on load when file does not exist, and holds empty list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voxel-repo-test-'));
    try {
      const repo = new FileProviderRepository(join(dir, 'providers.json'));
      const loaded = await repo.load();
      expect(loaded).toBe(false);
      expect(repo.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('seeds initial providers, persists them, and loads them on subsequent load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voxel-repo-test-'));
    try {
      const path = join(dir, 'providers.json');
      const repo = new FileProviderRepository(path);
      const defaults = createDefaultProviders({
        DEEPSEEK_API_KEY: 'test-key',
        DEEPSEEK_MODEL: 'custom-model',
      });
      await repo.seed(defaults);

      expect(repo.list()).toHaveLength(2);
      expect(repo.get('deepseek')).toMatchObject({
        id: 'deepseek',
        name: 'DeepSeek',
        type: 'deepseek',
        hasApiKey: true,
        defaultModel: 'custom-model',
      });
      expect(repo.get('deepseek')).not.toHaveProperty('apiKey');
      expect(repo.getRuntime('deepseek').apiKey).toBe('test-key');

      // Subsequent instance loads persisted data directly from disk
      const freshRepo = new FileProviderRepository(path);
      const loaded = await freshRepo.load();
      expect(loaded).toBe(true);
      expect(freshRepo.list()).toHaveLength(2);
      expect(freshRepo.get('deepseek')).not.toHaveProperty('apiKey');
      expect(freshRepo.getRuntime('deepseek').apiKey).toBe('test-key');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('bootstrapProviders seeds defaults when file does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voxel-repo-test-'));
    try {
      const path = join(dir, 'providers.json');
      const repo = new FileProviderRepository(path);
      await bootstrapProviders(repo, { DEEPSEEK_API_KEY: 'bootstrap-key' });

      expect(repo.list()).toHaveLength(2);
      expect(repo.getRuntime('deepseek').apiKey).toBe('bootstrap-key');

      // Bootstrapping again on an existing repo does not overwrite modifications
      await repo.save(
        { name: 'DeepSeek Modified', type: 'deepseek', apiKey: 'new-key' },
        'deepseek',
      );
      await bootstrapProviders(repo, { DEEPSEEK_API_KEY: 'another-key' });
      expect(repo.getRuntime('deepseek').apiKey).toBe('new-key');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports mutating providers via save and remove', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voxel-repo-test-'));
    try {
      const repo = new FileProviderRepository(join(dir, 'providers.json'));
      const view = await repo.save({
        name: 'Custom',
        type: 'compatible',
        baseUrl: 'https://custom.api.com',
        apiKey: 'sk-123',
        defaultModel: 'gpt-4o',
      });

      expect(view.hasApiKey).toBe(true);
      expect(repo.list()).toHaveLength(1);

      await repo.remove(view.id);
      expect(repo.list()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects creating a provider with an already existing ID', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voxel-repo-test-'));
    try {
      const repo = new FileProviderRepository(join(dir, 'providers.json'));
      await repo.save({
        id: 'my-custom-provider',
        name: 'Custom 1',
        type: 'compatible',
        baseUrl: 'https://custom.api.com',
      });

      await expect(
        repo.save({
          id: 'my-custom-provider',
          name: 'Custom 2',
          type: 'compatible',
          baseUrl: 'https://custom.api.com',
        }),
      ).rejects.toThrow('已存在相同 ID 的模型服务。');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
