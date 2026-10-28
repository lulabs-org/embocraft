import type { AICharacterTask } from '@voxel/shared';
import { emptyExecutionState, type RuntimeState } from '../../contracts/state';

/** Scheduled work retains character history, usage and inbox, and resets chat pacing. */
export function startScheduledTaskState(
  state: RuntimeState,
  task: AICharacterTask,
): RuntimeState {
  return {
    version: 4,
    character: {
      ...state.character,
      conversation: { exchanges: state.character.conversation.exchanges },
    },
    execution: { ...emptyExecutionState(), task: { current: task } },
  };
}

/** Resume the archived execution and conversation, retaining current cumulative usage. */
export function resumeTaskState(
  state: RuntimeState,
  archived: RuntimeState,
): RuntimeState {
  const restored = structuredClone(archived);
  restored.character.usage = state.character.usage;
  return restored;
}
