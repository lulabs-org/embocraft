import type { Message } from '@earendil-works/pi-ai';
import type { AgentRunState } from '../../contracts/state';
import { updateCheckpoint } from './checkpoint';
import { recentInteractions, recentTurns } from './window';

/** Conversations kept per character; the public one never expires. */
const MAX_PRIVATE_AUDIENCES = 16;
const REDACTED = '[已隐藏]';

/**
 * Persists one decision transcript: redacted, windowed, audience-scoped and
 * checkpointed. Message turns keep one conversation per audience; task turns
 * keep the trimmed task transcript so a crashed run can resume.
 */
export async function persistTranscript(input: {
  memory: AgentRunState;
  messages: Message[];
  scope: string;
  hasMessage: boolean;
  attached: boolean;
  apiKey?: string;
  save: () => Promise<void>;
}) {
  const clean = cleanTranscript(
    (input.hasMessage ? recentInteractions : recentTurns)(input.messages),
    input.apiKey,
  );
  if (input.hasMessage) rememberExchange(input.memory, input.scope, clean);
  if (input.attached && input.memory.task.current)
    updateCheckpoint(input.memory, clean);
  await input.save();
}

/** Serializes once, replaces the configured key, and deserializes a detached copy. */
function cleanTranscript(messages: Message[], apiKey?: string): Message[] {
  const serialized = JSON.stringify(messages);
  return JSON.parse(
    apiKey ? serialized.split(apiKey).join(REDACTED) : serialized,
  ) as Message[];
}

/** Keeps the newest private conversations; public and the current scope always survive. */
function rememberExchange(
  memory: AgentRunState,
  scope: string,
  messages: Message[],
) {
  const exchanges = (memory.conversation.exchanges ??= {});
  delete exchanges[scope];
  exchanges[scope] = messages;
  const privateScopes = Object.keys(exchanges).filter(
    (key) => key !== 'public',
  );
  for (const stale of privateScopes.slice(0, -MAX_PRIVATE_AUDIENCES))
    delete exchanges[stale];
}
