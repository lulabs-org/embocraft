import { emptyState, type AgentRunState } from '../contracts/state';

export const STATE_VERSION = 3;

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** v3 archives carry every partition. */
function isPartitioned(value: Record_): boolean {
  return (
    isRecord(value.task) &&
    isRecord(value.conversation) &&
    isRecord(value.checkpoint) &&
    isRecord(value.effects) &&
    isRecord(value.health)
  );
}

/** Restore a persisted runtime without replaying effects. */
export function restoreState(raw: unknown): AgentRunState {
  if (!isRecord(raw) || !isPartitioned(raw)) return emptyState();
  return normalize(raw);
}

function normalize(value: Record_): AgentRunState {
  const state = emptyState();
  state.task = { ...(value.task as Record_) } as AgentRunState['task'];
  state.conversation = {
    ...(value.conversation as Record_),
  } as AgentRunState['conversation'];
  state.checkpoint = {
    ...(value.checkpoint as Record_),
  } as AgentRunState['checkpoint'];
  state.effects = {
    ...(value.effects as Record_),
  } as AgentRunState['effects'];
  state.health = { ...(value.health as Record_) } as AgentRunState['health'];
  if (isRecord(value.inbox))
    state.inbox = value.inbox as AgentRunState['inbox'];
  return state;
}
