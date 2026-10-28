import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Connection } from './connection';
const sdk = vi.hoisted(() => ({ reconnect: vi.fn(), joinById: vi.fn() }));
vi.mock('colyseus.js', () => ({
  Client: class {
    reconnect = sdk.reconnect;
    joinById = sdk.joinById;
  },
}));
function roomMock() {
  const handlers = new Map<string, (data: unknown) => void>();
  let leaveCallback = () => {};
  return {
    sessionId: 'player',
    reconnectionToken: 'room:token',
    send: vi.fn(),
    leave: vi.fn().mockResolvedValue(1000),
    connection: { close: vi.fn() },
    onMessage: (type: string, callback: (data: unknown) => void) =>
      handlers.set(type, callback),
    onStateChange: vi.fn(),
    onError: vi.fn(),
    onLeave: (callback: () => void) => {
      leaveCallback = callback;
    },
    fireLeave: () => leaveCallback(),
    emit: (type: string, value: unknown) => handlers.get(type)?.(value),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  sdk.reconnect.mockReset();
  sdk.joinById.mockReset();
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ roomId: 'world' }))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('explicit game exit', () => {
  it('leaves consentfully, clears identity, stops spatial input, and allows a fresh entry', async () => {
    const first = roomMock();
    sdk.joinById.mockResolvedValue(first);
    const connection = new Connection();
    const stopSpatial = vi.fn();
    connection.stopSpatialInput = stopSpatial;
    sessionStorage.setItem('voxel-name', 'Explorer');
    await connection.connect('Explorer');
    connection.leave();
    expect(first.leave).toHaveBeenCalledWith(true);
    expect(connection.status).toBe('lobby');
    expect(connection.room).toBeUndefined();
    expect(sessionStorage.getItem('voxel-name')).toBeNull();
    expect(sessionStorage.getItem('voxel-reconnect')).toBeNull();
    expect(stopSpatial).toHaveBeenCalledTimes(1);
    first.fireLeave();
    await vi.runAllTimersAsync();
    expect(connection.status).toBe('lobby');
    expect(sdk.joinById).toHaveBeenCalledTimes(1);
    expect(stopSpatial).toHaveBeenCalledTimes(1);
    const second = roomMock();
    sdk.joinById.mockResolvedValue(second);
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ roomId: 'world' })),
    );
    await connection.connect('Again');
    expect(connection.status).toBe('connected');
    expect(connection.room).toBe(second);
    expect(sdk.reconnect).not.toHaveBeenCalled();
    connection.leave();
  });
  it('cancels a scheduled reconnect after a connection loss', async () => {
    const room = roomMock();
    sdk.joinById.mockResolvedValue(room);
    const connection = new Connection();
    await connection.connect('Explorer');
    room.fireLeave();
    expect(connection.status).toBe('disconnected');
    connection.leave();
    await vi.runAllTimersAsync();
    expect(connection.status).toBe('lobby');
    expect(sdk.joinById).toHaveBeenCalledTimes(1);
  });
  it('cancels retry after an initial connection failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
    const connection = new Connection();
    await connection.connect('Explorer');
    expect(connection.status).toBe('offline');
    connection.leave();
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(connection.status).toBe('lobby');
  });
  it('leaves a room whose join resolves after exit instead of restoring the session', async () => {
    let resolve!: (value: ReturnType<typeof roomMock>) => void;
    let started!: () => void;
    const joinStarted = new Promise<void>((r) => {
      started = r;
    });
    sdk.joinById.mockImplementation(() => {
      started();
      return new Promise((r) => {
        resolve = r;
      });
    });
    const connection = new Connection();
    const pending = connection.connect('Explorer');
    await joinStarted;
    connection.leave();
    const room = roomMock();
    resolve(room);
    await pending;
    expect(room.leave).toHaveBeenCalledWith(true);
    expect(connection.room).toBeUndefined();
    expect(connection.status).toBe('lobby');
    expect(sessionStorage.getItem('voxel-reconnect')).toBeNull();
  });
  it('aborts world discovery and ignores its late failure', async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((_resolve, r) => {
          reject = r;
        }),
    );
    const connection = new Connection();
    const pending = connection.connect('Explorer');
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    connection.leave();
    expect(signal?.aborted).toBe(true);
    reject(new Error('aborted'));
    await pending;
    await vi.runAllTimersAsync();
    expect(connection.status).toBe('lobby');
    expect(connection.messages).toEqual([]);
    expect(sdk.joinById).not.toHaveBeenCalled();
  });
});

describe('nickname rejection', () => {
  const ROOM_ERROR_NAME_TAKEN = 4409;

  it('returns to the lobby without retries and allows changing the name', async () => {
    sdk.joinById.mockRejectedValue(
      Object.assign(new Error('name taken'), { code: ROOM_ERROR_NAME_TAKEN }),
    );
    sessionStorage.setItem('voxel-name', 'Explorer');
    sessionStorage.setItem('voxel-reconnect', 'expired');
    sdk.reconnect.mockRejectedValue(new Error('expired'));
    const connection = new Connection();
    await connection.connect('Explorer');
    expect(connection.status).toBe('lobby');
    expect(connection.joinError).toContain('昵称已被使用');
    expect(connection.room).toBeUndefined();
    expect(sessionStorage.getItem('voxel-name')).toBeNull();
    expect(sessionStorage.getItem('voxel-reconnect')).toBeNull();
    await vi.runAllTimersAsync();
    expect(sdk.joinById).toHaveBeenCalledTimes(1);
    sdk.joinById.mockResolvedValue(roomMock());
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ roomId: 'world' })),
    );
    await connection.connect('Another');
    expect(connection.status).toBe('connected');
    expect(connection.joinError).toBe('');
    connection.leave();
  });

  it('localizes nickname rejection message in English', async () => {
    const { i18n } = await import('../i18n');
    await i18n.changeLanguage('en');
    try {
      sdk.joinById.mockRejectedValue(
        Object.assign(new Error('name taken'), { code: ROOM_ERROR_NAME_TAKEN }),
      );
      const connection = new Connection();
      await connection.connect('Explorer');
      expect(connection.status).toBe('lobby');
      expect(connection.joinError).toContain('This nickname is already taken');
    } finally {
      await i18n.changeLanguage('zh');
    }
  });
});
