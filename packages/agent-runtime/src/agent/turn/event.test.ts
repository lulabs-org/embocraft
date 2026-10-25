import type { WorldEvent } from '@voxel/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  emptyState,
  type AgentRunState,
  type CharacterEvent,
} from '../../contracts/state';
import type { TaskLease } from '../task/service';
import { claimEvent, settleEvent } from './event';

function message(seq = 1): WorldEvent {
  return {
    seq,
    at: 1,
    type: 'chat',
    actor: 'alice',
    actorKind: 'human',
    data: {
      scope: 'private',
      name: 'Alice',
      text: 'hello',
      kind: 'text',
      recipients: ['ai'],
    },
  } as unknown as WorldEvent;
}

function lease(revision = 1): TaskLease {
  return { id: 'task', revision, startedAt: 1 };
}

function planEvent(overrides: Partial<CharacterEvent> = {}): CharacterEvent {
  return {
    id: 'plan:1',
    kind: 'plan',
    state: 'pending',
    at: 1,
    audience: 'public',
    taskId: 'task',
    revision: 1,
    ...overrides,
  };
}

function memory(...events: CharacterEvent[]): AgentRunState {
  return { ...emptyState(), inbox: { version: 1, events } };
}

describe('event claims', () => {
  it('records and claims a chat message as processing', async () => {
    const state = memory();
    const claim = await claimEvent({ memory: state, message: message() });
    expect(claim?.event?.kind).toBe('chat');
    expect(claim?.event?.state).toBe('processing');
    expect(state.inbox?.events).toHaveLength(1);
  });

  it('rejects an already settled event', async () => {
    const state = memory();
    const first = await claimEvent({ memory: state, message: message() });
    settleEvent(first?.event, 'done');
    const second = await claimEvent({ memory: state, message: message() });
    expect(second).toBeUndefined();
  });

  it('marks an event from another task revision unknown and saves', async () => {
    const state = memory(planEvent());
    const checkpoint = vi.fn();
    const claim = await claimEvent({
      memory: state,
      expected: lease(2),
      checkpoint,
    });
    expect(claim).toBeUndefined();
    expect(state.inbox?.events[0].state).toBe('unknown');
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });

  it('picks the pending event that belongs to the expected task', async () => {
    const state = memory(
      planEvent({ id: 'plan:other', taskId: 'other' }),
      planEvent({ id: 'plan:mine' }),
    );
    const claim = await claimEvent({ memory: state, expected: lease(1) });
    expect(claim?.event?.id).toBe('plan:mine');
    expect(claim?.event?.state).toBe('processing');
  });

  it('runs an unattended turn with no event', async () => {
    const claim = await claimEvent({ memory: memory(), expected: lease(1) });
    expect(claim).toEqual({ event: undefined });
  });
});

describe('event settlement', () => {
  it('never overwrites an unknown event with done', () => {
    const event = planEvent({ state: 'unknown' });
    settleEvent(event, 'done');
    expect(event.state).toBe('unknown');
  });

  it('never overwrites a done event with unknown', () => {
    const event = planEvent({ state: 'done' });
    settleEvent(event, 'unknown');
    expect(event.state).toBe('done');
  });
});
