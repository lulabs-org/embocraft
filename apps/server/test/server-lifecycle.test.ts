import { Session, until } from '@voxel/agent-runtime';
import { DEFAULT_BAILIAN_ASR } from '@voxel/shared';
import { MANAGEMENT_EVENTS_VERSION } from '@voxel/shared/management';
import { access } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { env } from '../src/core/config/env';
import { createServer } from '../src/server';
import { createTestServer } from './helpers/test-server';

import { whisperModelsDirectory } from '../src/modules/audio/services/asr/whisper-settings';
import { WorldStore } from '../src/modules/world/persistence/store';

describe('server assembly and lifecycle', () => {
  it('keeps original data locations and validates deployment configuration without dotenv side effects', () => {
    expect(whisperModelsDirectory).toBe(env.dataPath('voice'));
    expect(env.readServer({})).toMatchObject({
      port: 2567,
      host: '127.0.0.1',
      webOrigin: 'http://127.0.0.1:5173',
      databaseUrl: '',
    });
    expect(
      env.readServer({ SERVER_PORT: '0', HOST: '0.0.0.0', WEB_ORIGIN: '*' })
        .port,
    ).toBe(0);
    for (const testEnv of [
      { SERVER_PORT: 'no' },
      { SERVER_PORT: '65536' },
      { SERVER_PORT: '-1' },
      { HOST: '' },
      { WEB_ORIGIN: 'https://example.test/path' },
    ])
      expect(() => env.readServer(testEnv)).toThrow();
    expect(
      env.readSpeech({ SPEECH_API_URL: 'http://speech:8000/v1' }).speechApiUrl,
    ).toBe('http://speech:8000/v1');
  });

  it('preserves HTTP contracts and closes SSE, ASR, Gateway and world clients idempotently', async () => {
    const origin = 'http://127.0.0.1:5199';
    const server = await createTestServer({
      origin,
      asrBridge: (socket) => {
        socket.send(JSON.stringify({ type: 'ready' }));
        return () => {};
      },
    });
    let human: Session | undefined;
    let asr: WebSocket | undefined;
    let gateway: WebSocket | undefined;
    const sseAbort = new AbortController();
    try {
      expect(await (await fetch(server.httpUrl + '/health')).json()).toEqual({
        ok: true,
        protocol: 1,
        persistence: 'memory',
      });
      expect(await (await fetch(server.httpUrl + '/world')).json()).toEqual({
        roomId: server.world.roomId,
      });
      for (const path of [
        '/ai-characters',
        '/providers',
        '/voice/asr/services',
        '/chat/audio/missing',
      ])
        expect((await fetch(server.httpUrl + path)).status, path).toBe(
          path.startsWith('/chat/') ? 403 : 401,
        );
      const rejected = await fetch(server.httpUrl + '/ai-characters', {
        headers: { Origin: 'https://foreign.example' },
      });
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toEqual({
        error: '不允许此页面管理 Agent。',
      });
      const options = await fetch(server.httpUrl + '/ai-characters', {
        method: 'OPTIONS',
        headers: { Origin: origin },
      });
      expect(options.status).toBe(204);
      expect(options.headers.get('access-control-allow-methods')).toBe(
        'GET, POST, PUT, DELETE, OPTIONS',
      );
      expect(options.headers.get('vary')).toBe('Origin');
      const badType = await fetch(server.httpUrl + '/ai-characters', {
        method: 'POST',
        headers: {
          Origin: origin,
          Authorization: 'Bearer fixture-gateway-token-for-tests',
        },
        body: 'x',
      });
      expect(badType.status).toBe(415);
      expect(await badType.json()).toEqual({ error: '请使用 JSON 请求。' });
      const badJson = await fetch(server.httpUrl + '/ai-characters', {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          Authorization: 'Bearer fixture-gateway-token-for-tests',
        },
        body: '{',
      });
      expect(badJson.status).toBe(400);
      expect(await badJson.json()).toEqual({
        error: '无法处理请求，请检查输入或本机配置文件权限。',
      });
      expect(
        (
          await fetch(server.httpUrl + '/world/presence', {
            headers: { Origin: 'https://foreign.example' },
          })
        ).status,
      ).toBe(403);
      human = await new Session(server.url).join('Lifecycle test', 'human');
      const presence = await fetch(server.httpUrl + '/world/presence', {
        headers: { Origin: origin },
        signal: sseAbort.signal,
      });
      expect(presence.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      const reader = presence.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain(
        human.room.sessionId,
      );
      const service = await server.asrSettings.save({
        ...DEFAULT_BAILIAN_ASR,
        name: 'Lifecycle ASR',
        apiKey: 'fixture-only',
      });
      asr = new WebSocket(
        `${server.url}/voice/asr/realtime?language=zh&serviceId=${service.id}`,
        { origin },
      );
      await new Promise<void>((resolve, reject) => {
        asr!.once('message', () => resolve());
        asr!.once('error', reject);
      });
      await expect(server.asrSettings.remove(service.id)).rejects.toThrow(
        '正在识别',
      );
      gateway = new WebSocket(`${server.url}/ai-characters/gateway`, {
        origin,
      });
      const gatewayConnected = new Promise<unknown>((resolve, reject) => {
        gateway!.once('message', (data) =>
          resolve(JSON.parse(data.toString())),
        );
        gateway!.once('error', reject);
        gateway!.once('open', () =>
          gateway!.send(
            JSON.stringify({
              type: 'connect',
              version: MANAGEMENT_EVENTS_VERSION,
              client: 'web',
              token: 'fixture-gateway-token-for-tests',
            }),
          ),
        );
      });
      expect(await gatewayConnected).toEqual({
        type: 'connected',
        version: MANAGEMENT_EVENTS_VERSION,
      });
      // Both custom routes participate in Colyseus' shared heartbeat.
      await Promise.all(
        [asr, gateway].map(
          (socket) =>
            new Promise<void>((resolve) =>
              socket.once('ping', () => resolve()),
            ),
        ),
      );
      const gatewayClosed = new Promise<void>((resolve) =>
        gateway!.once('close', () => resolve()),
      );
      const socketClosed = new Promise<void>((resolve) =>
        asr!.once('close', () => resolve()),
      );
      const sseEnded = (async () => {
        try {
          while (!(await reader.read()).done) {
            // Drain the stream until server shutdown closes it.
          }
        } catch {
          // Forced shutdown may abort the stream instead of ending it cleanly.
        } finally {
          reader.releaseLock();
        }
      })();
      await Promise.all([server.close(), server.close()]);
      await socketClosed;
      await gatewayClosed;
      await sseEnded;
      await until(() => !human!.room.connection.isOpen, 1000);
      await expect(access(server.directory)).rejects.toThrow();
      expect(server.http.listening).toBe(false);
    } finally {
      sseAbort.abort();
      asr?.terminate();
      gateway?.terminate();
      await human?.close();
      await server.close();
    }
  }, 15000);

  it('stops before listening or loading stores when database diagnostics fail', async () => {
    await expect(
      createServer({
        config: env.readServer({}),
        databaseCheck: async () => {
          throw Error('database unavailable');
        },
      }),
    ).rejects.toThrow('database unavailable');
  });

  it('releases a failed world startup so a fresh server can start and close', async () => {
    const store = new WorldStore('');
    vi.spyOn(store, 'load').mockRejectedValueOnce(Error('world load failed'));
    const closed = vi.spyOn(store, 'close');
    await expect(createTestServer({ worldStore: store })).rejects.toThrow(
      'world load failed',
    );
    expect(closed).toHaveBeenCalled();
    const recovered = await createTestServer();
    try {
      expect((await fetch(recovered.httpUrl + '/health')).status).toBe(200);
    } finally {
      await recovered.close();
    }
  });
});
