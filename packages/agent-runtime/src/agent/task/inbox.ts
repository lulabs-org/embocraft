import type { ChatData, WorldEvent } from '@voxel/shared';
import type { AgentRunState, CharacterEvent } from '../../contracts/state';

/** One stable id per generation/actor/seq so retries never duplicate input. */
export function chatEventId(
  generation: string | undefined,
  event: Pick<WorldEvent, 'actor' | 'seq'>,
) {
  return `chat:${generation ?? 'standalone'}:${event.actor}:${event.seq}`;
}

/** Public messages stay public; private and nearby messages belong to their actor. */
export function chatAudience(event: Pick<WorldEvent, 'actor' | 'data'>) {
  return (event.data as ChatData).scope === 'public' ? 'public' : event.actor;
}

/** Record a chat event before it is queued so a crash cannot lose the input. */
export function recordChatEvent(
  memory: AgentRunState,
  event: WorldEvent,
  generation?: string,
): CharacterEvent {
  return recordEvent(memory, {
    id: chatEventId(generation, event),
    kind: 'chat',
    state: 'pending',
    at: event.at,
    audience: chatAudience(event),
    actor: event.actor,
    message: event,
  });
}

/** Record an event into the agent's mailbox, deduplicating and pruning audit history. */
export function recordEvent(memory: AgentRunState, event: CharacterEvent) {
  const inbox = (memory.inbox ??= { version: 1, events: [] });
  const old = inbox.events.find((e) => e.id === event.id);
  if (old) return old;
  inbox.events.push(event);
  // Keep all outstanding inputs and a bounded audit trail.
  const done = inbox.events
    .filter((e) => ['done', 'unknown'].includes(e.state))
    .slice(-64);
  inbox.events = [
    ...inbox.events.filter((e) => !['done', 'unknown'].includes(e.state)),
    ...done,
  ];
  return event;
}
