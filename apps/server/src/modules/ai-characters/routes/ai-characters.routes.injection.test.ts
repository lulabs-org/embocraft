import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { expect, it, vi } from 'vitest';
import type {
  AICharacterRoutePort,
  CharacterDetail,
  CharacterQueryPort,
} from '../ports';
import { createAICharacterRouter } from './ai-characters.routes';

it('uses the supplied query and management ports without sharing another router’s manager', async () => {
  const detail = { id: 'character', taskIdentity: null } as CharacterDetail;
  const queries: CharacterQueryPort = {
    list: vi.fn(async () => [detail]),
    get: vi.fn(async () => detail),
    logs: vi.fn(async () => ({
      entries: [{ time: 10, text: 'saved' }],
      total: 1,
    })),
  };
  const manager = {
    events: { version: 7 },
    sessionId: () => 'session',
  } as unknown as AICharacterRoutePort;
  const app = express();
  app.use(
    '/other',
    createAICharacterRouter(queries, {
      ...manager,
      events: { version: 12 },
      sessionId: () => 'other-session',
    }),
  );
  app.use(createAICharacterRouter(queries, manager));
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
    expect(
      await (await fetch(`${base}/other/ai-characters/character`)).json(),
    ).toEqual({
      ...detail,
      sessionId: 'other-session',
      resourceVersion: 12,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
