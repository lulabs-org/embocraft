import { CHAT_PACE_INTERVAL_MS } from '@voxel/shared';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeState } from '../../contracts/state';

/** Conversation replies and task reports share the world's per-player rate limit. */
export async function paceChat(memory: RuntimeState, signal: AbortSignal) {
  if (memory.character.conversation.lastChatAt)
    await delay(
      Math.max(
        0,
        CHAT_PACE_INTERVAL_MS -
          (Date.now() - memory.character.conversation.lastChatAt),
      ),
      undefined,
      { signal },
    );
  signal.throwIfAborted();
  memory.character.conversation.lastChatAt = Date.now();
}
