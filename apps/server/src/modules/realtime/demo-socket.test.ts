import { afterEach, expect, it } from 'vitest';

import type { RealtimeEvent } from '@voxel/shared/communication';

import { BailianSession } from './bailian-session';

import { DemoSocket } from './demo-socket';

const sessions: BailianSession[] = [];

afterEach(() => sessions.splice(0).forEach((s) => s.close()));

it('plays deterministic demo protocol without credentials or network', async () => {
  const events: RealtimeEvent[] = [];
  const s = new BailianSession(true, undefined, (e) => events.push(e));
  sessions.push(s);
  s.start(
    {
      enabled: false,
      workspace: 'offline',
      credential: () => {
        throw Error();
      },
    },
    () => new DemoSocket(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  s.commit('demo');
  await new Promise((resolve) => setImmediate(resolve));
  expect(events.some((e) => e.kind === 'audio')).toBe(true);
  expect(events.at(-1)?.kind).toBe('done');
  expect(events.every((e) => e.demo)).toBe(true);
});
