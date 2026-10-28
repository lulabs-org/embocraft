import {
  emptyState,
  newTask,
  type AgentRunState,
  type BatchResult,
} from '@voxel/agent-runtime';
import { expect, it } from 'vitest';
import { navigationWorld } from '../../../../../tests/support/navigation-world';
import { prepareDecision } from './prepare';

function fixture() {
  const w = navigationWorld({ x: 4, y: 3.5, z: 0 });
  const old = { type: 'goto' as const, x: 4, y: 2.5, z: 0 };
  const next = { ...old, y: 3.5 };
  const pending: BatchResult = {
    actions: [old],
    remaining: [],
    ok: false,
    stopReason: 'failed',
    results: [
      {
        action: old,
        status: 'failed',
        result: {
          ok: false,
          status: 'failed',
          code: 'target_blocked',
          note: 'wrong height',
          position: w.body,
          target: old,
          replans: 0,
        },
      },
    ],
  };
  const previous: BatchResult = {
    actions: [next],
    remaining: [],
    ok: true,
    stopReason: 'completed',
    results: [
      {
        action: next,
        status: 'succeeded',
        result: {
          ok: true,
          status: 'arrived',
          note: 'verified arrival',
          position: w.body,
          target: next,
          replans: 0,
        },
      },
    ],
  };
  const memory: AgentRunState = {
    ...emptyState(),
    task: { current: newTask('到我这里来') },
    effects: { pendingEffects: pending, previous },
  };
  const reconcile = () =>
    prepareDecision(w.session, memory, new AbortController().signal);
  return { w, pending, previous, memory, reconcile };
}

it('a verified corrected destination supersedes a known failed goto', async () => {
  const f = fixture();
  await f.reconcile();
  expect(f.memory.effects.pendingEffects).toBeUndefined();
});
it.each(['unknown', 'not-arrived', 'chat-only', 'failed-edit'] as const)(
  'does not erase unresolved effects after %s',
  async (kind) => {
    const f = fixture();
    if (kind === 'unknown') f.pending.results[0].status = 'unknown';
    if (kind === 'not-arrived') f.w.body.x = 0;
    if (kind === 'chat-only')
      f.previous.results = [
        {
          action: { type: 'chat', text: '我到了' },
          status: 'succeeded',
          result: { ok: true, id: 'chat', revision: 1 },
        },
      ];
    if (kind === 'failed-edit')
      f.pending.results.push({
        action: { type: 'edit', x: 0, y: 4, z: 0, material: 'wood' },
        status: 'failed',
        result: { ok: false, id: 'edit', revision: 1 },
      });
    await f.reconcile();
    expect(f.memory.effects.pendingEffects).toBeDefined();
  },
);

it.each(['public', 'private', 'nearby', undefined] as const)(
  'only exposes the addressed event and authorized task context for a %s turn',
  async (scope) => {
    const w = navigationWorld({ x: 4, y: 3.5, z: 0 });
    const event = (
      actor: string,
      scope: string,
    ): import('@voxel/shared').WorldEvent => ({
      seq: 1,
      actor,
      actorKind: 'human',
      type: 'chat',
      at: 0,
      data: {
        scope,
        recipients: ['ai'],
        text: `${actor}-secret`,
        kind: 'text',
      },
    });
    const observation = await w.session.observe();
    const history = [event('alice', 'private'), event('bob', 'nearby')];
    const addressed = scope ? event('bob', scope) : undefined;
    const memory = emptyState();
    memory.task.current = newTask('alice-private-task', 'alice', 'alice');
    memory.effects.previous = { secret: 'alice-private-effects' };
    const prepared = await prepareDecision(
      { observe: async () => ({ ...observation, events: history }) },
      memory,
      new AbortController().signal,
      addressed,
    );
    expect(prepared!.observation.events).toEqual(addressed ? [addressed] : []);
    expect(prepared!.observation.events).not.toContainEqual(history[0]);
    expect(prepared!.privateTo).toBe(
      scope && scope !== 'public' ? 'bob' : undefined,
    );
    if (addressed) {
      expect(prepared!.visibleTask).toBeUndefined();
      expect(prepared!.context.previous).toBeUndefined();
    } else {
      expect(prepared!.visibleTask).toBe(memory.task.current);
      expect(prepared!.context.previous).toEqual(memory.effects.previous);
    }
    expect(memory.task.current.goal).toBe('alice-private-task');
  },
);
