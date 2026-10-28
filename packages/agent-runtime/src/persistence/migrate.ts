import { emptyState, type AgentRunState } from '../contracts/state';

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** v3 archives carry every partition; anything else is a flat v1/v2 runtime. */
function isPartitioned(value: Record_): boolean {
  return (
    isRecord(value.task) &&
    isRecord(value.conversation) &&
    isRecord(value.checkpoint) &&
    isRecord(value.effects) &&
    isRecord(value.health)
  );
}

/** Restore a persisted runtime without replaying effects; the only legacy-aware entry. */
export function restoreState(raw: unknown): AgentRunState {
  const value = isRecord(raw) ? raw : {};
  if (isPartitioned(value)) return normalize(value);
  return fromLegacy(value);
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

function fromLegacy(value: Record_): AgentRunState {
  const state = emptyState();
  state.task = {
    current: value.task as AgentRunState['task']['current'],
    identity: value.identity as AgentRunState['task']['identity'],
    usage: value.usage as AgentRunState['task']['usage'],
  };
  state.conversation = {
    exchanges: value.exchanges as AgentRunState['conversation']['exchanges'],
    lastChatAt: value.lastChatAt as number | undefined,
    lastReply: value.lastReply as AgentRunState['conversation']['lastReply'],
    audienceExpired: value.audienceExpired as boolean | undefined,
  };
  state.checkpoint = {
    pi: value.pi as AgentRunState['checkpoint']['pi'],
    unknownEffect:
      value.unknownEffect as AgentRunState['checkpoint']['unknownEffect'],
  };
  state.effects = {
    previous: value.previous,
    pendingEffects:
      value.pendingEffects as AgentRunState['effects']['pendingEffects'],
    unfinishedBuild:
      value.unfinishedBuild as AgentRunState['effects']['unfinishedBuild'],
    follow: value.follow as AgentRunState['effects']['follow'],
    activeAction:
      value.activeAction as AgentRunState['effects']['activeAction'],
  };
  state.health = {
    waitSignature: value.waitSignature as string | undefined,
    failures: value.failures as number | undefined,
    noProgress: value.noProgress as number | undefined,
    lastProgress: value.lastProgress as string | undefined,
    lastResponse: value.lastResponse as string | undefined,
    decisionError: value.decisionError as string | undefined,
  };
  if (isRecord(value.inbox))
    state.inbox = value.inbox as AgentRunState['inbox'];
  return state;
}
