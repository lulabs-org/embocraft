import { expect, it } from 'vitest';
import { createTestServer } from '../../../../test/helpers/test-server';

const origin = 'http://world.test';
const headers = {
  Authorization: 'Bearer fixture-gateway-token-for-tests',
  Origin: origin,
  'Content-Type': 'application/json',
};

it('returns consistent committed summaries for character detail, list and writes', async () => {
  const server = await createTestServer({ origin });
  try {
    const create = async (name: string) => {
      const response = await fetch(server.httpUrl + '/ai-characters', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          providerId: 'deepseek',
          name,
          joinWorld: false,
        }),
      });
      expect(response.status).toBe(201);
      return response.json();
    };
    const first = await create('First');
    const second = await create('Second');
    const url = `${server.httpUrl}/ai-characters/${second.id}`;
    const get = async (path: string) => {
      const response = await fetch(path, { headers });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await get(url)).toEqual(second);
    expect(second).not.toHaveProperty('logEntries');
    expect(second).not.toHaveProperty('lastLog');
    expect(second).not.toHaveProperty('lastLogAt');

    const job = server.characters.jobs.get(second.id)!;
    job.view.logEntries.push(
      { text: 'Older', time: 123 },
      { text: 'Latest legacy entry', time: null },
    );
    await server.characters.persistence.persist();
    const version = server.characters.events.version;
    // In-flight changes must not leak through the new single-character read.
    job.view.name = 'Not saved';
    job.view.logEntries.push({ text: 'Not saved', time: 456 });

    const detail = await get(url);
    expect(detail).toMatchObject({
      id: second.id,
      name: 'Second',
      resourceVersion: version,
      taskIdentity: null,
      lastLog: 'Latest legacy entry',
      lastLogAt: null,
    });
    expect(detail).not.toHaveProperty('logEntries');
    const list = await get(server.httpUrl + '/ai-characters');
    expect(list.map((character: { id: string }) => character.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(list[0]).toEqual(detail);
    expect(await get(url + '/logs')).toEqual({
      entries: [
        { text: 'Latest legacy entry', time: null },
        { text: 'Older', time: 123 },
      ],
      total: 2,
    });

    // The version is shared with other resources, so it cannot be cached per character.
    server.characters.events.publish('providers');
    expect(await get(url)).toEqual({ ...detail, resourceVersion: version + 1 });

    const removed = await fetch(url, { method: 'DELETE', headers });
    expect(removed.status).toBe(204);
    for (const path of [url, url + '/logs']) {
      const response = await fetch(path, { headers });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'AI 角色 不存在。' });
    }
  } finally {
    await server.close();
  }
});
