import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DatabaseVoiceServicePersistence } from './database-voice-services';
import type { SavedVoice } from '../services/voice-service-store';

describe('DatabaseVoiceServicePersistence', () => {
  it('returns empty array when table is empty', async () => {
    const db = {
      ttsProvider: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;

    const persistence = new DatabaseVoiceServicePersistence(db);
    expect(await persistence.load()).toEqual([]);
  });

  it('loads unpacked fields into SavedVoice models with optional voiceLanguage', async () => {
    const db = {
      ttsProvider: {
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

  it('creates, updates and deletes individual records inside a transaction', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      ttsProvider: {
        aggregate: vi.fn().mockResolvedValue({ _max: { position: 3 } }),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };
    const db = {
      $transaction: vi.fn(async (cb: (prisma: typeof tx) => Promise<unknown>) =>
        cb(tx),
      ),
    } as unknown as PrismaClient;
    const persistence = new DatabaseVoiceServicePersistence(db);
    const voice: SavedVoice = {
      id: 'service-1',
      name: 'Test Voice',
      type: 'compatible',
      baseUrl: 'https://tts.example.com',
      apiKey: 'secret',
      model: 'tts-1',
      voice: 'alloy',
      speed: 1,
    };

    await persistence.transaction(async (repo) => {
      await repo.create(voice);
      await repo.update({ ...voice, name: 'Renamed' });
      await repo.remove(voice.id);
    });
    expect(tx.ttsProvider.create).toHaveBeenCalledWith({
      data: { ...voice, position: 4, voiceLanguage: null },
    });
    expect(tx.ttsProvider.update).toHaveBeenCalledWith({
      where: { id: voice.id },
      data: {
        name: 'Renamed',
        type: voice.type,
        baseUrl: voice.baseUrl,
        apiKey: voice.apiKey,
        model: voice.model,
        voice: voice.voice,
        speed: voice.speed,
        voiceLanguage: null,
      },
    });
    expect(tx.ttsProvider.delete).toHaveBeenCalledWith({
      where: { id: voice.id },
    });
  });

  it('throws AppError on database load/save failure', async () => {
    const db = {
      ttsProvider: {
        findMany: vi.fn().mockRejectedValue(new Error('connection timeout')),
      },
      $transaction: vi.fn().mockRejectedValue(new Error('transaction aborted')),
    } as unknown as PrismaClient;

    const persistence = new DatabaseVoiceServicePersistence(db);
    await expect(persistence.load()).rejects.toThrow(
      '无法读取语音服务数据库配置。',
    );
    await expect(persistence.transaction(async () => {})).rejects.toThrow(
      '无法保存语音服务数据库配置。',
    );
  });
});
