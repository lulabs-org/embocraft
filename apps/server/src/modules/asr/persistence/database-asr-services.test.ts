import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DatabaseAsrServicePersistence } from './database-asr-services';
import type { SavedService } from './asr-settings-store';

describe('DatabaseAsrServicePersistence', () => {
  it('returns empty array if asrService table is empty', async () => {
    const db = {
      asrService: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;

    const persistence = new DatabaseAsrServicePersistence(db);
    expect(await persistence.load()).toEqual([]);
  });

  it('loads unpacked fields into SavedService for both Bailian and Whisper providers', async () => {
    const db = {
      asrService: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'bailian-1',
            position: 0,
            name: 'Bailian ASR',
            provider: 'bailian',
            model: 'fun-asr-realtime',
            apiKey: 'bailian-key',
            uses: ['chat'],
            region: 'beijing',
            workspaceId: 'ws-1',
            baseUrl: null,
            temperature: null,
            prompt: null,
          },
          {
            id: 'whisper-1',
            position: 1,
            name: 'Whisper Local',
            provider: 'whisper',
            model: 'Systran/faster-whisper-base',
            apiKey: 'whisper-key',
            uses: ['spatial', 'clip'],
            region: null,
            workspaceId: null,
            baseUrl: 'http://localhost:8000/v1',
            temperature: 0.2,
            prompt: 'Minecraft voxel world',
          },
        ]),
      },
    } as unknown as PrismaClient;

    const persistence = new DatabaseAsrServicePersistence(db);
    const result = await persistence.load();

    expect(result).toEqual([
      {
        id: 'bailian-1',
        name: 'Bailian ASR',
        provider: 'bailian',
        model: 'fun-asr-realtime',
        apiKey: 'bailian-key',
        region: 'beijing',
        workspaceId: 'ws-1',
        uses: ['chat'],
      },
      {
        id: 'whisper-1',
        name: 'Whisper Local',
        provider: 'whisper',
        model: 'Systran/faster-whisper-base',
        apiKey: 'whisper-key',
        baseUrl: 'http://localhost:8000/v1',
        temperature: 0.2,
        prompt: 'Minecraft voxel world',
        uses: ['spatial', 'clip'],
      },
    ]);
  });

  it('saves unpacked Bailian and Whisper fields and removes missing records in a transaction', async () => {
    const findManyServices = vi.fn().mockResolvedValue([{ id: 'old-service' }]);
    const deleteService = vi.fn().mockResolvedValue({});
    const upsertService = vi.fn().mockResolvedValue({});

    const tx = {
      asrService: {
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

    const persistence = new DatabaseAsrServicePersistence(db);
    const services: SavedService[] = [
      {
        id: 'b-1',
        name: 'Bailian Model',
        provider: 'bailian',
        model: 'fun-asr-realtime',
        region: 'singapore',
        workspaceId: 'ws-2',
        apiKey: 'b-key',
        uses: ['chat'],
      },
      {
        id: 'w-1',
        name: 'Whisper Model',
        provider: 'whisper',
        model: 'Systran/faster-whisper-base',
        baseUrl: 'http://localhost:8000',
        temperature: 0,
        prompt: '',
        apiKey: '',
      },
    ];

    await persistence.save(services);

    expect(deleteService).toHaveBeenCalledWith({ where: { id: 'old-service' } });

    expect(upsertService).toHaveBeenCalledWith({
      where: { id: 'b-1' },
      create: {
        id: 'b-1',
        position: 0,
        name: 'Bailian Model',
        provider: 'bailian',
        model: 'fun-asr-realtime',
        apiKey: 'b-key',
        uses: ['chat'],
        region: 'singapore',
        workspaceId: 'ws-2',
        baseUrl: null,
        temperature: null,
        prompt: null,
      },
      update: {
        position: 0,
        name: 'Bailian Model',
        provider: 'bailian',
        model: 'fun-asr-realtime',
        apiKey: 'b-key',
        uses: ['chat'],
        region: 'singapore',
        workspaceId: 'ws-2',
        baseUrl: null,
        temperature: null,
        prompt: null,
      },
    });

    expect(upsertService).toHaveBeenCalledWith({
      where: { id: 'w-1' },
      create: {
        id: 'w-1',
        position: 1,
        name: 'Whisper Model',
        provider: 'whisper',
        model: 'Systran/faster-whisper-base',
        apiKey: '',
        uses: [],
        region: null,
        workspaceId: null,
        baseUrl: 'http://localhost:8000',
        temperature: 0,
        prompt: '',
      },
      update: {
        position: 1,
        name: 'Whisper Model',
        provider: 'whisper',
        model: 'Systran/faster-whisper-base',
        apiKey: '',
        uses: [],
        region: null,
        workspaceId: null,
        baseUrl: 'http://localhost:8000',
        temperature: 0,
        prompt: '',
      },
    });
  });

  it('throws AppError on database load/save failure', async () => {
    const db = {
      asrService: {
        findMany: vi.fn().mockRejectedValue(new Error('db connection error')),
      },
      $transaction: vi.fn().mockRejectedValue(new Error('transaction aborted')),
    } as unknown as PrismaClient;

    const persistence = new DatabaseAsrServicePersistence(db);
    await expect(persistence.load()).rejects.toThrow('无法读取 ASR 数据库配置。');
    await expect(persistence.save([])).rejects.toThrow('无法保存 ASR 数据库配置。');
  });
});

