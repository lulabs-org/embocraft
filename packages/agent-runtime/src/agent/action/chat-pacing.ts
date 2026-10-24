import { setTimeout as delay } from 'node:timers/promises';
import { CHAT_PACE_INTERVAL_MS } from '@voxel/shared';
import type { AgentRunState } from '../../contracts/state';

/** Conversation replies and task reports share the world's per-player rate limit. */
export async function paceChat(memory: AgentRunState, signal: AbortSignal) {
  if (memory.conversation.lastChatAt)
    await delay(
      Math.max(
        0,
        CHAT_PACE_INTERVAL_MS - (Date.now() - memory.conversation.lastChatAt),
      ),
      undefined,
      { signal },
    );
  signal.throwIfAborted();
  memory.conversation.lastChatAt = Date.now();
}
