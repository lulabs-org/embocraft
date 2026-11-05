import { describe, expect, it, vi } from 'vitest';
import EventEmitter from 'node:events';
import type WebSocket from 'ws';
import { RealtimeAsrService } from './realtime-asr.service';
import type { AsrSettingsStore } from './asr-settings-store';
import { AppError } from '../../../core/errors/app-error';
import { DEFAULT_BAILIAN_ASR } from '@voxel/shared';

function createMockClient() {
  const emitter = new EventEmitter();
  return emitter as unknown as WebSocket;
}

describe('RealtimeAsrService', async () => {
  it('acquires store lease and invokes bridge for valid session', async () => {
    const release = vi.fn();
    const mockStore = {
      acquire: vi.fn().mockReturnValue({
        settings: { ...DEFAULT_BAILIAN_ASR, provider: 'bailian' },
        release,
      }),
    } as unknown as AsrSettingsStore;

    const bridge = vi.fn();
    const service = new RealtimeAsrService(mockStore, { bridge });

    const client = createMockClient();
    await service.startSession(client, 'service-1', 'zh');

    expect(mockStore.acquire).toHaveBeenCalledWith('service-1');
    expect(bridge).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ provider: 'bailian' }),
      'zh',
    );
    expect(service.runningSessions).toBe(1);

    (client as unknown as EventEmitter).emit('close');
    expect(release).toHaveBeenCalledOnce();
    expect(service.runningSessions).toBe(0);
  });

  it.each(['openai', 'gemini'] as const)(
    'routes %s sessions through the live bridge and releases their lease',
    async (provider) => {
      const release = vi.fn();
      const settings = {
        provider,
        name: 'Live',
        model: 'model',
        apiKey: 'secret',
      };
      const store = {
        acquire: vi.fn().mockReturnValue({ settings, release }),
      } as unknown as AsrSettingsStore;
      const liveBridge = vi.fn();
      const bailianBridge = vi.fn();
      const service = new RealtimeAsrService(store, {
        bridge: bailianBridge,
        liveBridge,
      });
      const client = createMockClient();
      await service.startSession(client, 'live-service', 'en');
      expect(liveBridge).toHaveBeenCalledWith(client, settings, 'en');
      expect(bailianBridge).not.toHaveBeenCalled();
      expect(service.runningSessions).toBe(1);
      (client as unknown as EventEmitter).emit('close');
      expect(release).toHaveBeenCalledOnce();
      expect(service.runningSessions).toBe(0);
    },
  );

  it('rejects Whisper provider and releases acquired lease', async () => {
    const release = vi.fn();
    const mockStore = {
      acquire: vi.fn().mockReturnValue({
        settings: { provider: 'whisper' },
        release,
      }),
    } as unknown as AsrSettingsStore;

    const bridge = vi.fn();
    const service = new RealtimeAsrService(mockStore, { bridge });
    const client = createMockClient();

    await expect(
      service.startSession(client, 'whisper-service', 'zh'),
    ).rejects.toThrow(new AppError('Whisper 服务请使用服务器音频识别接口。'));
    expect(release).toHaveBeenCalledOnce();
    expect(bridge).not.toHaveBeenCalled();
    expect(service.runningSessions).toBe(0);
  });

  it('rejects requests when maxConcurrency is exceeded', async () => {
    const release1 = vi.fn();
    const release2 = vi.fn();
    const release3 = vi.fn();
    const mockStore = {
      acquire: vi
        .fn()
        .mockReturnValueOnce({
          settings: { ...DEFAULT_BAILIAN_ASR, provider: 'bailian' },
          release: release1,
        })
        .mockReturnValueOnce({
          settings: { ...DEFAULT_BAILIAN_ASR, provider: 'bailian' },
          release: release2,
        })
        .mockReturnValueOnce({
          settings: { ...DEFAULT_BAILIAN_ASR, provider: 'bailian' },
          release: release3,
        }),
    } as unknown as AsrSettingsStore;

    const bridge = vi.fn();
    const service = new RealtimeAsrService(mockStore, {
      bridge,
      maxConcurrency: 2,
    });

    const client1 = createMockClient();
    const client2 = createMockClient();
    const client3 = createMockClient();

    await service.startSession(client1, 's1', 'zh');
    await service.startSession(client2, 's2', 'zh');
    expect(service.runningSessions).toBe(2);

    await expect(service.startSession(client3, 's3', 'zh')).rejects.toThrow(
      new AppError('实时识别服务繁忙，请稍后重试。'),
    );

    // After client1 closes, client3 can be accepted
    (client1 as unknown as EventEmitter).emit('close');
    expect(service.runningSessions).toBe(1);

    await service.startSession(client3, 's3', 'zh');
    expect(service.runningSessions).toBe(2);
  });
  it('releases a lease acquired after the client closes', async () => {
    let resolve!: (value: {
      settings: typeof DEFAULT_BAILIAN_ASR;
      release: () => void;
    }) => void;
    const release = vi.fn();
    const store = {
      acquire: () =>
        new Promise((done) => {
          resolve = done;
        }),
    } as unknown as AsrSettingsStore;
    const bridge = vi.fn();
    const service = new RealtimeAsrService(store, {
      bridge,
      maxConcurrency: 1,
    });
    const client = createMockClient();
    const starting = service.startSession(client, 'service', 'zh');
    expect(service.runningSessions).toBe(1);
    (client as unknown as EventEmitter).emit('close');
    resolve({ settings: DEFAULT_BAILIAN_ASR, release });
    await starting;
    expect(release).toHaveBeenCalledOnce();
    expect(bridge).not.toHaveBeenCalled();
    expect(service.runningSessions).toBe(0);
  });
});
