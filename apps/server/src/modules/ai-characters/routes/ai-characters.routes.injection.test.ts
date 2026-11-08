import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { expect, it, vi } from 'vitest';
import { bindCharacterManager } from '../application/character-orchestrator';
import type {
  AICharacterRoutePort,
  CharacterDetail,
  CharacterQueryPort,
} from '../ports';
import { createAICharacterRouter } from './ai-characters.routes';

it('uses the query port supplied to the router for lists, details, and logs', async () => {
  const detail = { id: 'character', taskIdentity: null } as CharacterDetail;
  const queries: CharacterQueryPort = {
    list: vi.fn(async () => [detail]),
    get: vi.fn(async () => detail),
    logs: vi.fn(async () => ({
      entries: [{ time: 10, text: 'saved' }],
      total: 1,
    })),
  };
  const release = bindCharacterManager({
    events: { version: 7 },
    sessionId: () => 'session',
  } as unknown as AICharacterRoutePort);
  const app = express();
  app.use(createAICharacterRouter(queries));
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const expected = { ...detail, sessionId: 'session', resourceVersion: 7 };
    expect(await (await fetch(`${base}/ai-characters`)).json()).toEqual([
      expected,
    ]);
    expect(
      await (await fetch(`${base}/ai-characters/character`)).json(),
    ).toEqual(expected);
    expect(
      await (
        await fetch(`${base}/ai-characters/character/logs?limit=1`)
      ).json(),
    ).toEqual({
      entries: [{ time: 10, text: 'saved' }],
      total: 1,
    });
    expect(queries.list).toHaveBeenCalledOnce();
    expect(queries.get).toHaveBeenCalledWith('character');
    expect(queries.logs).toHaveBeenCalledWith('character', 1, 0);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
