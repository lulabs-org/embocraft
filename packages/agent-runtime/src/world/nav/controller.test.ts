import { physics, signal } from '../../../test/navigation-physics';
import { describe, it, expect, vi } from 'vitest';
import { navigate } from './controller';
import { navigationWorld } from '../../../../../tests/support/navigation-world';
vi.mock('node:timers/promises', async (original) => ({
  ...(await original<typeof import('node:timers/promises')>()),
  setTimeout: (
    ms: number,
    value: unknown,
    options?: { signal?: AbortSignal },
  ) =>
    new Promise((resolve, reject) => {
      const signal = options?.signal;
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      }, ms);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    }),
}));
describe('grounded navigation', () => {
  it.each(['flat', 'wall', 'step', 'down', 'far'] as const)(
    'physically reaches %s using the server integrator',
    async (kind) => {
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
        ],
      });
      const w = navigationWorld(
        kind === 'down' ? { x: 0, y: 3.501, z: 0 } : undefined,
      );
      const target = { x: kind === 'far' ? 11 : 4, y: 2.5, z: 0 };
      if (kind === 'wall')
        for (let z = -2; z <= 2; z++)
          for (let y = 3; y <= 6; y++) w.put(2, y, z);
      if (kind === 'step') {
        for (let x = 2; x <= 5; x++)
          for (let z = -12; z <= 12; z++) w.put(x, 3, z);
        target.y = 3.5;
      }
      if (kind === 'down') w.put(0, 3, 0);
      const timer = setInterval(w.tick, 50);
      try {
        const pending = navigate(
          w.session,
          { type: 'goto', ...target },
          w.observe(),
          signal(),
        );
        let done = false;
        void pending.then(() => {
          done = true;
        });
        for (let i = 0; i < 350 && !done; i++) {
          await vi.advanceTimersByTimeAsync(100);
          await new Promise<void>((r) => setImmediate(r));
        }
        const result = await pending;
        expect(result, JSON.stringify(w.body)).toMatchObject({
          ok: true,
          status: 'arrived',
        });
        expect(
          Math.hypot(w.body.x - target.x, w.body.z - target.z),
        ).toBeLessThan(0.19);
        expect(w.body.grounded).toBe(true);
        expect(w.moves.at(-1)).toMatchObject({ x: 0, z: 0, jump: false });
      } finally {
        clearInterval(timer);
        vi.useRealTimers();
      }
    },
  );
});

it('replans when an obstacle is added during movement', async () => {
  const w = navigationWorld();
  const result = await physics(w, async () => {
    setTimeout(() => {
      for (let z = -1; z <= 1; z++) for (let y = 3; y <= 6; y++) w.put(3, y, z);
      w.changed();
    }, 300);
    return navigate(
      w.session,
      { type: 'goto', x: 5, y: 2.5, z: 0 },
      w.observe(),
      signal(),
    );
  });
  expect(result).toMatchObject({ ok: true, status: 'arrived' });
});
it('rejects an occupied destination', async () => {
  const w = navigationWorld();
  w.put(1, 3, 0);
  const blocked = await navigate(
    w.session,
    { type: 'goto', x: 1, y: 2.5, z: 0 },
    w.observe(),
    signal(),
  );
  expect(blocked.code).toBe('target_blocked');
});
it('stops on cancellation and on observation failure', async () => {
  const w = navigationWorld(),
    abort = new AbortController();
  await expect(
    physics(w, async () => {
      setTimeout(() => abort.abort(new Error('cancelled')), 250);
      return navigate(
        w.session,
        { type: 'goto', x: 8, y: 2.5, z: 0 },
        w.observe(),
        abort.signal,
      );
    }),
  ).rejects.toThrow('cancelled');
  expect(w.moves.at(-1)).toMatchObject({ x: 0, z: 0 });
  await expect(
    physics(w, () =>
      navigate(
        {
          ...w.session,
          request: async () => {
            throw Error('offline');
          },
        },
        { type: 'goto', x: 8, y: 2.5, z: 0 },
        w.observe(),
        signal(),
      ),
    ),
  ).rejects.toThrow('offline');
  expect(w.moves.at(-1)).toMatchObject({ x: 0, z: 0 });
});
it('never assumes a truncated or stale observation is a navigation map', async () => {
  const w = navigationWorld(),
    o = w.observe();
  o.navigation!.revision++;
  expect(
    (
      await navigate(
        w.session,
        { type: 'goto', x: 1, y: 2.5, z: 0 },
        o,
        signal(),
      )
    ).code,
  ).toBe('map_unavailable');
  expect(w.moves.filter((m) => m.x || m.z)).toHaveLength(0);
});
it('returns bounded stalled failure even when the server does not move', async () => {
  const w = navigationWorld();
  w.tick = () => {};
  const result = await physics(w, () =>
    navigate(
      w.session,
      { type: 'goto', x: 4, y: 2.5, z: 0 },
      w.observe(),
      signal(),
    ),
  );
  expect(result.ok).toBe(false);
  expect(['stalled', 'no_path_in_known_area']).toContain(result.code);
  expect(w.moves.at(-1)).toMatchObject({ x: 0, z: 0 });
});

it('keeps stall rate below 5% across 100 reproducible reachable terrain cases', async () => {
  let failed = 0;
  const failures: unknown[] = [];
  for (let seed = 0; seed < 100; seed++) {
    const w = navigationWorld();
    const direction = seed % 2 ? 1 : -1;
    const kind = Math.floor(seed / 2) % 4;
    const target = {
      type: 'goto' as const,
      x: direction * (4 + (seed % 3)),
      y: kind === 2 ? 3.5 : 2.5,
      z: (seed % 3) - 1,
    };
    if (kind === 1 || kind === 3) {
      for (let z = -(seed % 3); z <= seed % 3; z++)
        for (let y = 3; y <= 5; y++) w.put(direction * 2, y, z);
    }
    if (kind === 2)
      for (let x = 2; x <= 7; x++)
        for (let z = -12; z <= 12; z++) w.put(direction * x, 3, z);
    if (kind === 3) {
      w.put(direction * 4, 3, 2);
      w.put(direction * 4, 4, 2);
    }
    const result = await physics(w, () =>
      navigate(w.session, target, w.observe(), signal()),
    );
    if (!result.ok) {
      failed++;
      failures.push({ seed, code: result.code });
    }
  }
  expect(failed, JSON.stringify(failures)).toBeLessThan(5);
  console.log(
    `Navigation reachable-case matrix: ${100 - failed}/100 arrived; ${failed}% failure/stall rate.`,
  );
}, 30000);

