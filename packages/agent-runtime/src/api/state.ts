import type { AICharacterTask } from '@voxel/shared';
import { emptyState, type AgentRunState } from '../contracts/state';
import {
  characterState,
  composeState,
  restoreStateSnapshot,
  taskExecutionState,
} from '../agent/state/ownership';

/**
 * Host plan dispatch: attach a fresh execution to the existing character.
 * Preserve the established scheduled-start behavior: history, usage and inbox
 * survive, while the chat pacing timestamp starts afresh.
 */
export function startScheduledTaskState(
  state: AgentRunState,
  task: AICharacterTask,
): AgentRunState {
  const character = characterState(state);
  character.conversation = { exchanges: character.conversation.exchanges };
  const execution = taskExecutionState(emptyState());
  execution.task.current = task;
  return composeState(character, execution);
}

/**
 * Historical resume retains the existing archived-conversation semantics.
 * The character total always comes from the live character, never the archive.
 * Other archive data is detached; task/lease references retain the v3 behavior.
 */
export function resumeTaskState(
  state: AgentRunState,
  archived: AgentRunState,
): AgentRunState {
  const snapshot = structuredClone(archived);
  const character = characterState(snapshot);
  character.usage = state.task.usage;
  const execution = taskExecutionState(snapshot);
  execution.task = taskExecutionState(archived).task;
  return composeState(character, execution);
}

/** Restore a host transaction without invalidating the active runtime reference. */
export function rollbackTaskState(
  state: AgentRunState,
  snapshot: AgentRunState,
): void {
  restoreStateSnapshot(state, snapshot);
}
