import type { WorldEvent } from '@voxel/shared';
import type { AgentRunState, CharacterEvent } from '../../contracts/state';
import type { AgentAttention } from '../../world/observe/attention';
import { recordChatEvent } from '../task/inbox';
import type { TaskLease } from '../task/service';

/** The event this turn will process; `event` is absent for unattended task turns. */
export type EventClaim = { event?: CharacterEvent };

/**
 * Claims the queued event for this turn.
 *
 * Returns undefined when the turn must not run: the event was settled already,
 * or it belongs to another task revision (then it is marked unknown and saved).
 * Otherwise the event moves to `processing`, so a crash cannot replay it as
 * pending.
 */
export async function claimEvent(input: {
  memory: AgentRunState;
  message?: WorldEvent;
  attention?: AgentAttention;
  expected?: TaskLease;
  checkpoint?: () => void | Promise<void>;
}): Promise<EventClaim | undefined> {
  const event: CharacterEvent | undefined = input.message
    ? recordChatEvent(input.memory, input.message, input.attention?.generation)
    : input.memory.inbox?.events.find(
        (candidate) =>
          candidate.state === 'pending' &&
          candidate.kind !== 'chat' &&
          (candidate.kind !== 'plan' ||
            candidate.taskId === input.expected?.id),
      );
  if (event && ['done', 'unknown'].includes(event.state)) return undefined;
  if (event?.taskId && !eventMatchesLease(event, input.expected)) {
    event.state = 'unknown';
    await input.checkpoint?.();
    return undefined;
  }
  if (event) event.state = 'processing';
  return { event };
}

/** Settles a claimed event without overwriting a stronger final state. */
export function settleEvent(
  event: CharacterEvent | undefined,
  state: 'done' | 'unknown',
) {
  if (!event || event.state === (state === 'done' ? 'unknown' : 'done')) return;
  event.state = state;
}

/** An event may only run while its task revision is still the current one. */
function eventMatchesLease(
  event: CharacterEvent,
  expected: TaskLease | undefined,
): boolean {
  return (
    !!expected &&
    event.taskId === expected.id &&
    event.revision === expected.revision
  );
}
