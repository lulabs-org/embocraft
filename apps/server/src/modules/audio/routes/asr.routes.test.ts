import {
  DEFAULT_BAILIAN_ASR,
  DEFAULT_WHISPER_ASR,
  type BailianAsrDraft,
} from '@voxel/shared';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { TestAsrSettingsStore as AsrSettingsStore } from '../../../../test/helpers/memory-storage';

import { RoutedWebSocketTransport } from '../../../core/transport/websocket.transport';
import { LocalSpeech } from '../services/asr/local-speech.service';
import { createAsrSocket } from '../sockets/asr.socket';
import { installAsrRoutes } from './asr.routes.ts';
import { installCapabilitiesRoutes } from './capabilities.routes';

let server: Server,
  transport: RoutedWebSocketTransport,
  store: AsrSettingsStore,
  url: string;
const clients: WebSocket[] = [];
const bridge = vi.fn((client: WebSocket, _settings: BailianAsrDraft) => {
  client.send(JSON.stringify({ type: 'ready' }));
  return () => {};
});
const origin = 'http://127.0.0.1:5173';
beforeEach(async () => {
  vi.stubEnv('WEB_ORIGIN', origin);
  bridge.mockClear();
  store = new AsrSettingsStore();
  await store.load();
  const app = express();
  const speech = new LocalSpeech();
  vi.spyOn(speech, 'status').mockResolvedValue({
    available: true,
    reason: 'local',
  });
  installCapabilitiesRoutes(app, speech, store);
  installAsrRoutes(app, store);
  server = createServer(app);
  transport = new RoutedWebSocketTransport(
    server,
    new Map([['/voice/asr/realtime', createAsrSocket(store, bridge)]]),
  );
  await new Promise<void>((resolve) =>
    transport.listen(0, '127.0.0.1', undefined, resolve),
  );
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  clients.splice(0).forEach((client) => client.terminate());
  await new Promise<void>((resolve) => {
    server.once('close', resolve);
    transport.shutdown();
    server.closeAllConnections();
  });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const socket = (serviceId = '', pageOrigin = origin) =>
  new Promise<{
    client: WebSocket;
    message: { type: string; message?: string };
  }>((resolve, reject) => {
    const client = new WebSocket(
      `${url.replace('http', 'ws')}/voice/asr/realtime?language=zh&serviceId=${encodeURIComponent(serviceId)}`,
      { origin: pageOrigin },
    );
    clients.push(client);
    client.on('error', reject);
    client.once('message', (data) =>
      resolve({ client, message: JSON.parse(data.toString()) }),
    );
  });
it('requires the page origin for reading and saving masked configuration', async () => {
  expect((await fetch(`${url}/voice/asr/services`)).status).toBe(403);
  const response = await fetch(`${url}/voice/asr/services`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...DEFAULT_BAILIAN_ASR,
      name: '测试服务',
      apiKey: 'private-test-key',
    }),
  });
  expect(response.status).toBe(201);
  const value = await response.json();
  expect(value.hasApiKey).toBe(true);
  expect(JSON.stringify(value)).not.toContain('private-test-key');
  expect(
    (
      await fetch(`${url}/voice/asr/services`, { headers: { Origin: origin } })
    ).headers.get('cache-control'),
  ).toBe('no-store');
  const invalid = await fetch(`${url}/voice/asr/services`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...DEFAULT_BAILIAN_ASR,
      name: '测试服务',
      region: 'other',
      apiKey: 'key',
    }),
  });
  expect(invalid.status).toBe(400);
  expect((await fetch(`${url}/voice/capabilities`)).status).toBe(200);
});
it('rejects missing credentials and other origins before opening paid tasks', async () => {
  expect((await socket()).message.type).toBe('error');
  await store.save({
    ...DEFAULT_BAILIAN_ASR,
    name: '测试服务',
    apiKey: 'private-test-key',
  });
  expect((await socket('any-id', 'https://example.com')).message.type).toBe(
    'error',
  );
  expect(bridge).not.toHaveBeenCalled();
});
it('does not echo malformed configuration bodies or secrets', async () => {
  const response = await fetch(`${url}/voice/asr/services`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: '{"apiKey":"secret-malformed",',
  });
  expect(response.status).toBe(400);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.text()).not.toContain('secret-malformed');
});
it('dispatches live sockets and bounds concurrent upstream tasks', async () => {
  const service = await store.save({
    ...DEFAULT_BAILIAN_ASR,
    name: '测试服务',
    apiKey: 'private-test-key',
  });
  const a = await socket(service.id);
  const b = await socket(service.id);
  expect(a.message).toEqual({ type: 'ready' });
  expect(b.message).toEqual({ type: 'ready' });
  expect((await socket(service.id)).message.message).toContain('繁忙');
  expect(bridge).toHaveBeenCalledTimes(2);
  await new Promise<void>((resolve) => {
    a.client.once('close', resolve);
    a.client.close();
  });
  expect((await socket(service.id)).message.type).toBe('ready');
});
it('releases all ASR service references when the shared transport closes connections', async () => {
  const service = await store.save({
    ...DEFAULT_BAILIAN_ASR,
    name: 'Closing ASR',
    apiKey: 'fixture-only',
  });
  const a = await socket(service.id);
  const b = await socket(service.id);
  await expect(store.remove(service.id)).rejects.toThrow('正在识别');
  const closed = [a, b].map(
    ({ client }) =>
      new Promise<void>((resolve) => client.once('close', () => resolve())),
  );
  transport.closeConnections();
  await Promise.all(closed);
  await vi.waitFor(() => {
    for (const [client] of bridge.mock.calls)
      expect(client.readyState).toBe(WebSocket.CLOSED);
  });
  // A new session must be admitted after both slots are released.
  expect((await socket(service.id)).message.type).toBe('ready');
  transport.closeConnections();
  await vi.waitFor(() =>
    expect(bridge.mock.calls[2][0].readyState).toBe(WebSocket.CLOSED),
  );
  await store.remove(service.id);
  expect(store.list()).toEqual([]);
});
it('routes each selected service to its own model and key, rejects missing or deleted IDs, and guards deletion', async () => {
  const a = await store.save({
    ...DEFAULT_BAILIAN_ASR,
    name: '模型 A',
    apiKey: 'key-a',
  });
  const b = await store.save({
    ...DEFAULT_BAILIAN_ASR,
    name: '模型 B',
    apiKey: 'key-b',
    model: 'paraformer-realtime-v2',
  });
  expect((await socket()).message.type).toBe('error');
  expect((await socket('missing')).message.type).toBe('error');
  expect(bridge).not.toHaveBeenCalled();
  const sa = await socket(a.id);
  const sb = await socket(b.id);
  expect(bridge.mock.calls[0][1]).toMatchObject({
    model: 'fun-asr-realtime',
    apiKey: 'key-a',
  });
  expect(bridge.mock.calls[1][1]).toMatchObject({
    model: 'paraformer-realtime-v2',
    apiKey: 'key-b',
  });
  const path = `${url}/voice/asr/services/${a.id}`;
  expect(
    (await fetch(path, { method: 'DELETE', headers: { Origin: origin } }))
      .status,
  ).toBe(409);
  await new Promise<void>((resolve) => {
    sa.client.once('close', resolve);
    sa.client.close();
  });
  // Client close may arrive before the server releases the service reference.
  await vi.waitFor(() =>
    expect(bridge.mock.calls[0][0].readyState).toBe(WebSocket.CLOSED),
  );
  expect(
    (await fetch(path, { method: 'DELETE', headers: { Origin: origin } }))
      .status,
  ).toBe(204);
  expect((await socket(a.id)).message.type).toBe('error');
  expect(store.list()).toEqual([b]);
  expect(sb.client.readyState).toBe(WebSocket.OPEN);
});
it('supports separate create, edit and delete HTTP resources and cross-origin preflight', async () => {
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const create = (name: string, model = 'fun-asr-realtime') =>
    fetch(`${url}/voice/asr/services`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...DEFAULT_BAILIAN_ASR,
        name,
        model,
        apiKey: `key-${name}`,
      }),
    }).then((r) => r.json());
  const a = await create('A'),
    b = await create('B', 'paraformer-realtime-v2');
  expect(a.id).not.toBe(b.id);
  const edited = await fetch(`${url}/voice/asr/services/${a.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ ...a, name: 'A renamed', apiKey: '' }),
  });
  expect(edited.status).toBe(200);
  expect(store.get(a.id)).toMatchObject({ apiKey: 'key-A' });
  expect(store.get(b.id).model).toBe('paraformer-realtime-v2');
  expect(
    (
      await fetch(`${url}/voice/asr/services/missing`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ ...a, apiKey: 'test' }),
      })
    ).status,
  ).toBe(404);
  const preflight = await fetch(`${url}/voice/asr/services/${a.id}`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT' },
  });
  expect(preflight.headers.get('access-control-allow-methods')).toContain(
    'PUT',
  );
  expect(preflight.headers.get('access-control-allow-methods')).toContain(
    'DELETE',
  );
  await fetch(`${url}/voice/asr/services/${a.id}`, {
    method: 'DELETE',
    headers,
  });
  const list = await fetch(`${url}/voice/asr/services`, { headers }).then((r) =>
    r.json(),
  );
  expect(list).toEqual([b]);
});

it('rejects Whisper profiles on the cloud socket without starting a cloud task', async () => {
  const local = await store.save({
    ...DEFAULT_WHISPER_ASR,
    provider: 'whisper',
    name: 'local',
  });
  expect((await socket(local.id)).message).toMatchObject({
    type: 'error',
    message: expect.stringContaining('Whisper'),
  });
  expect(bridge).not.toHaveBeenCalled();
  await store.remove(local.id);
});
