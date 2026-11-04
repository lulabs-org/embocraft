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

describe('RealtimeAsrService', () => {
  it('acquires store lease and invokes bridge for valid session', () => {
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
    service.startSession(client, 'service-1', 'zh');

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

  it('rejects Whisper provider and releases acquired lease', () => {
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

    expect(() => service.startSession(client, 'whisper-service', 'zh')).toThrow(
      new AppError('Whisper 服务请使用服务器音频识别接口。'),
    );
    expect(release).toHaveBeenCalledOnce();
    expect(bridge).not.toHaveBeenCalled();
    expect(service.runningSessions).toBe(0);
  });

  it('rejects requests when maxConcurrency is exceeded', () => {
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

    service.startSession(client1, 's1', 'zh');
    service.startSession(client2, 's2', 'zh');
    expect(service.runningSessions).toBe(2);

    expect(() => service.startSession(client3, 's3', 'zh')).toThrow(
      new AppError('实时识别服务繁忙，请稍后重试。'),
    );

    // After client1 closes, client3 can be accepted
    (client1 as unknown as EventEmitter).emit('close');
    expect(service.runningSessions).toBe(1);

    service.startSession(client3, 's3', 'zh');
    expect(service.runningSessions).toBe(2);
  });
});
