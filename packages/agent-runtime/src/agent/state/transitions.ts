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

/** Restore only the historical execution; character memory always remains current. */
export function resumeTaskState(
  state: RuntimeState,
  archived: RuntimeState,
): RuntimeState {
  return structuredClone({
    version: state.version,
    character: state.character,
    execution: archived.execution,
  });
}
