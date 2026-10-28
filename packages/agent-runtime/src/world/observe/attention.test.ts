import { AgentAttention } from '@voxel/agent-runtime';
import { expect, it } from 'vitest';

import type { WorldEvent } from '@voxel/shared';
const message = (
  seq: number,
  scope = 'public',
  recipients = ['ai'],
): WorldEvent => ({
  seq,
  actorKind: 'human',
  actor: 'person',
  type: 'chat',
  at: 0,
  data: { scope, recipients, kind: 'text', text: 'hi', name: 'Person' },
});
it('wakes a long interval promptly, deduplicates, and only accepts addressed human chat', async () => {
  const inbox = new AgentAttention(),
    abort = new AbortController();
  const wait = inbox.wait(60000, abort.signal);
  expect(inbox.push(message(1, 'public', []), 'ai')).toBe(false);
  expect(inbox.push(message(2, 'private', ['other']), 'ai')).toBe(false);
  expect(inbox.push(message(3, 'nearby', ['other']), 'ai')).toBe(false);
  expect(inbox.push(message(4), 'ai')).toBe(true);
  await wait;
  expect(inbox.push(message(4), 'ai')).toBe(false);
  expect(inbox.take()?.seq).toBe(4);
  expect(inbox.pending).toBe(false);
  const next = inbox.wait(60000, abort.signal);
  abort.abort();
  await next;
});
it('bounds queued mentions and clears pending messages', () => {
  const inbox = new AgentAttention();
  for (let seq = 1; seq <= 10; seq++) inbox.push(message(seq), 'ai');
  expect(inbox.rejected).toBe(true);
  expect(inbox.take()?.seq).toBe(1);
  inbox.clear();
  expect(inbox.pending).toBe(false);
});
