import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DatabaseVoiceServicePersistence } from './database-voice-services';
import type { SavedVoice } from './voice-service-store';

describe('DatabaseVoiceServicePersistence', () => {
  it('returns undefined if catalog state is absent and table is empty', async () => {
    const db = {
      ttsCatalogState: { findUnique: vi.fn().mockResolvedValue(null) },
      ttsService: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;

    const persistence = new DatabaseVoiceServicePersistence(db);
    expect(await persistence.load()).toBeUndefined();
  });

  it('loads unpacked fields into SavedVoice models with optional voiceLanguage', async () => {
    const db = {
      ttsCatalogState: { findUnique: vi.fn().mockResolvedValue({ id: 1 }) },
      ttsService: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'speaches-1',
            position: 0,
            name: 'Local Piper',
            type: 'speaches',
            baseUrl: 'http://localhost:8000',
            apiKey: 'key-1',
            model: 'piper-zh',
            voice: 'huayan',
            speed: 1.0,
            voiceLanguage: null,
          },
          {
            id: 'browser-1',
            position: 1,
            name: 'Web Speech',
            type: 'browser',
            baseUrl: '',
            apiKey: '',
            model: '',
            voice: 'Ting-Ting',
            speed: 1.2,
            voiceLanguage: 'zh-CN',
          },
        ]),
      },
    } as unknown as PrismaClient;

    const persistence = new DatabaseVoiceServicePersistence(db);
    const result = await persistence.load();

    expect(result).toEqual([
      {
        id: 'speaches-1',
        name: 'Local Piper',
        type: 'speaches',
        baseUrl: 'http://localhost:8000',
        apiKey: 'key-1',
        model: 'piper-zh',
        voice: 'huayan',
        speed: 1.0,
      },
      {
        id: 'browser-1',
        name: 'Web Speech',
        type: 'browser',
        baseUrl: '',
        apiKey: '',
        model: '',
        voice: 'Ting-Ting',
        speed: 1.2,
        voiceLanguage: 'zh-CN',
      },
    ]);
  });

  it('saves unpacked fields and deletes missing entries in a transaction', async () => {
    const upsertCatalogState = vi.fn().mockResolvedValue({});
    const findManyServices = vi.fn().mockResolvedValue([{ id: 'old-service' }]);
    const deleteService = vi.fn().mockResolvedValue({});
    const upsertService = vi.fn().mockResolvedValue({});

    const tx = {
      ttsCatalogState: { upsert: upsertCatalogState },
      ttsService: {
        findMany: findManyServices,
        delete: deleteService,
        upsert: upsertService,
      },
    };

    const db = {
      $transaction: vi.fn(async (cb: (prisma: typeof tx) => Promise<unknown>) =>
        cb(tx),
      ),
    } as unknown as PrismaClient;

    const persistence = new DatabaseVoiceServicePersistence(db);
    const services: SavedVoice[] = [
      {
        id: 'service-1',
        name: 'Test Voice',
        type: 'compatible',
        baseUrl: 'https://tts.example.com',
        apiKey: 'secret',
        model: 'tts-1',
        voice: 'alloy',
        speed: 1.0,
      },
    ];

    await persistence.save(services);

    expect(deleteService).toHaveBeenCalledWith({ where: { id: 'old-service' } });
    expect(upsertService).toHaveBeenCalledWith({
      where: { id: 'service-1' },
      create: {
        id: 'service-1',
        position: 0,
        name: 'Test Voice',
        type: 'compatible',
        baseUrl: 'https://tts.example.com',
        apiKey: 'secret',
        model: 'tts-1',
        voice: 'alloy',
        speed: 1.0,
        voiceLanguage: null,
      },
      update: {
        position: 0,
        name: 'Test Voice',
        type: 'compatible',
        baseUrl: 'https://tts.example.com',
        apiKey: 'secret',
        model: 'tts-1',
        voice: 'alloy',
        speed: 1.0,
        voiceLanguage: null,
      },
    });
  });

  it('throws AppError on database load/save failure', async () => {
    const db = {
      ttsCatalogState: {
        findUnique: vi.fn().mockRejectedValue(new Error('connection timeout')),
      },
      $transaction: vi.fn().mockRejectedValue(new Error('transaction aborted')),
    } as unknown as PrismaClient;

    const persistence = new DatabaseVoiceServicePersistence(db);
    await expect(persistence.load()).rejects.toThrow('无法读取语音服务数据库配置。');
    await expect(persistence.save([])).rejects.toThrow('无法保存语音服务数据库配置。');
  });
});

