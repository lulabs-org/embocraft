import { describe, it, expect, vi } from 'vitest';
import { CommandRouter } from '../src/modules/management';
import {
  ManagementError,
  MANAGEMENT_EVENTS_VERSION,
  ManagementEvents,
  managementRequest,
  UnknownOutcome,
  type SocketLike,
} from '@voxel/shared/management';
import { gatewaySocket } from '../src/modules/gateway/socket';
import { ManagementEvents as ServerManagementEvents } from '../src/modules/management';
import { EventEmitter } from 'node:events';
import { GatewayAuth } from '../src/modules/gateway/auth';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
describe('gateway command boundary', () => {
  it('coalesces concurrent commands and rejects reused IDs with different payloads', async () => {
    const router = new CommandRouter();
    let finish!: (v: unknown) => void;
    const action = vi.fn(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const a = router.run('same', { a: 1, b: 2 }, 'character', action),
      b = router.run('same', { b: 2, a: 1 }, 'character', action);
    await Promise.resolve();
    await Promise.resolve();
    expect(action).toHaveBeenCalledTimes(1);
    expect(router.get('same').state).toBe('pending');
    expect(() => router.run('same', { a: 2 }, 'character', action)).toThrow(
      '不同',
    );
    finish('saved');
    expect(await a).toBe('saved');
    expect(await b).toBe('saved');
    expect(router.get('same')).toMatchObject({
      state: 'committed',
      result: 'saved',
    });
  });
  it('serializes state commits per Agent while allowing different Agents', async () => {
    const router = new CommandRouter(),
      order: string[] = [];
    let release!: () => void;
    const a = router.run('1', {}, 'a', async () => {
      order.push('a1');
      await new Promise<void>((r) => (release = r));
    });
    const b = router.run('2', {}, 'a', async () => order.push('a2'));
    await router.run('3', {}, 'b', async () => order.push('b'));
    expect(order).toEqual(['a1', 'b']);
    release();
    await Promise.all([a, b]);
    expect(order.at(-1)).toBe('a2');
  });
  it('retains rejection receipts, hides internal errors, and expires completed commands only', async () => {
    const router = new CommandRouter();
    await expect(
      router.run('bad', {}, 'a', async () => {
        throw Error('secret');
      }),
    ).rejects.toThrow();
    expect(JSON.stringify(router.get('bad'))).not.toContain('secret');
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 600001);
    expect(router.get('bad').state).toBe('unknown');
    clock.mockRestore();
  });
  it('generates private stable credentials and never treats wildcard Origin as authorization', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gateway-auth-'));
    try {
      const tokenFile = join(dir, 'token');
      const auth = await GatewayAuth.load({
        tokenFile,
        origins: ['http://localhost'],
      });
      const token = (await readFile(tokenFile, 'utf8')).trim();
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
      expect(auth.verify(token)).toBe(true);
      expect(auth.verify('wrong')).toBe(false);
      expect(auth.acceptsOrigin('https://other')).toBe(false);
      expect(auth.acceptsOrigin(undefined)).toBe(true);
      const next = await GatewayAuth.load({ tokenFile, origins: [] });
      expect(next.verify(token)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
class FakeSocket implements SocketLike {
  readyState = 1;
  listeners = new Map<
    string,
    ((e: { type: string; data?: unknown }) => void)[]
  >();
  sent: { type: string }[] = [];
  addEventListener(
    t: string,
    f: (e: { type: string; data?: unknown }) => void,
  ) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), f]);
  }
  emit(t: string, e: { data?: unknown } = {}) {
    for (const f of this.listeners.get(t) ?? []) f({ type: t, ...e });
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  frame(value: unknown) {
    this.emit('message', { data: JSON.stringify(value) });
  }
}
class ServerSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames: import('@voxel/shared/management').ManagementFrame[] = [];
  closeCode?: number;
  send(raw: string) {
    this.frames.push(JSON.parse(raw));
  }
  close(code: number) {
    this.closeCode = code;
    this.readyState = 3;
    this.emit('close');
  }
  frame(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
}
function serverSocket(
  gateway: Partial<Parameters<typeof gatewaySocket>[0]>,
  origin = 'http://localhost',
) {
  const socket = new ServerSocket();
  gatewaySocket(
    gateway as Parameters<typeof gatewaySocket>[0],
    new GatewayAuth('fixture-gateway-token-for-tests', ['http://localhost']),
    socket as unknown as Parameters<typeof gatewaySocket>[2],
    { headers: { origin } } as Parameters<typeof gatewaySocket>[3],
  );
  return socket;
}
const hello = {
  type: 'connect',
  version: MANAGEMENT_EVENTS_VERSION,
  client: 'web',
  token: 'fixture-gateway-token-for-tests',
};
it('rejects missing handshake, unsupported version, Origin, malformed/oversize frames and handshake timeout', () => {
  vi.useFakeTimers();
  try {
    const gateway = {};
    for (const frame of [
      { type: 'req', id: 'x', method: 'characters.list', params: {} },
      { ...hello, version: 1 },
      { ...hello, token: 'wrong' },
    ]) {
      const socket = serverSocket(gateway);
      socket.frame(frame);
      expect(socket.closeCode).toBe(1008);
    }
    const foreign = serverSocket(gateway, 'https://foreign');
    foreign.frame(hello);
    expect(foreign.closeCode).toBe(1008);
    const large = serverSocket(gateway);
    large.emit('message', Buffer.alloc(32769), false);
    expect(large.closeCode).toBe(1008);
    const malformed = serverSocket(gateway);
    malformed.emit('message', Buffer.from('{'), false);
    expect(malformed.closeCode).toBe(1008);
    const timeout = serverSocket(gateway);
    vi.advanceTimersByTime(5001);
    expect(timeout.closeCode).toBe(1008);
  } finally {
    vi.useRealTimers();
  }
});

it('sends refresh then ordered changes, rejects commands and cleans up subscriptions', () => {
  const events = new ServerManagementEvents();
  const socket = serverSocket(events);
  socket.frame(hello);
  events.publish('characters', ['a']);
  expect(
    socket.frames
      .filter((f) => f.type === 'event')
      .map((f) => [f.event, f.seq]),
  ).toEqual([
    ['snapshot', 1],
    ['changed', 2],
  ]);
  socket.frame({
    type: 'req',
    method: 'characters.delete',
    params: { characterId: 'a' },
  });
  expect(socket.closeCode).toBe(1008);
  const count = socket.frames.length;
  events.publish('characters', ['a']);
  expect(socket.frames).toHaveLength(count);
  const slow = serverSocket(events);
  slow.frame(hello);
  slow.bufferedAmount = 1048577;
  events.publish('characters', ['a']);
  expect(slow.closeCode).toBe(1013);
});

it('reconnects notifications after an initial failure and never sends commands', async () => {
  const sockets: FakeSocket[] = [];
  const client = new ManagementEvents({
    url: 'ws://fixture',
    token: () => 'fixture',
    socket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  try {
    const first = client.connect();
    sockets[0].close();
    await expect(first).rejects.toThrow();
    const second = client.connect();
    sockets[1].emit('open');
    sockets[1].frame({ type: 'connected', version: MANAGEMENT_EVENTS_VERSION });
    await second;
    expect(sockets[1].sent.map((v) => v.type)).toEqual(['connect']);
    const changes = vi.fn();
    client.onEvent(changes);
    sockets[1].frame({ type: 'event', event: 'snapshot', seq: 1, data: null });
    sockets[1].frame({ type: 'event', event: 'changed', seq: 3, data: {} });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(sockets[1].readyState).toBe(3);
  } finally {
    client.close();
  }
});

it.each([401, 403])(
  'stops reconnecting when authentication fails (%s)',
  async (status) => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const factory = vi.fn(() => socket);
    const client = new ManagementEvents({
      url: 'ws://fixture',
      token: () => 'wrong',
      socket: factory,
    });
    try {
      const ready = client.connect();
      socket.frame({
        type: 'error',
        error: { status, code: 'UNAUTHORIZED', message: 'denied' },
      });
      await expect(ready).rejects.toBeInstanceOf(ManagementError);
      expect(client.state).toBe('unauthorized');
      vi.advanceTimersByTime(15000);
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      client.close();
      vi.useRealTimers();
    }
  },
);
it('rejects incompatible notification versions', async () => {
  const socket = new FakeSocket();
  const client = new ManagementEvents({
    url: 'ws://fixture',
    token: () => '',
    socket: () => socket,
  });
  const ready = client.connect();
  socket.frame({ type: 'connected', version: 2 });
  await expect(ready).rejects.toThrow('协议版本不兼容');
  client.close();
});
it('never retries a write with an uncertain HTTP outcome and retains the receipt ID', async () => {
  const http = vi.fn().mockRejectedValue(new TypeError('network closed'));
  vi.stubGlobal('fetch', http);
  try {
    await expect(
      managementRequest('/tasks', {
        token: 'fixture',
        method: 'POST',
        body: {},
        commandId: 'stable',
      }),
    ).rejects.toMatchObject({ commandId: 'stable' });
    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0][1].headers['Idempotency-Key']).toBe('stable');
    const abort = new AbortController();
    abort.abort();
    await expect(
      managementRequest('/tasks', {
        token: 'fixture',
        method: 'POST',
        signal: abort.signal,
      }),
    ).rejects.not.toBeInstanceOf(UnknownOutcome);
    expect(http).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
