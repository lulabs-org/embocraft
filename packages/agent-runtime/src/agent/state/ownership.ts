import type {
  AgentRunState,
  CharacterState,
  TaskExecutionState,
} from '../../contracts/state';

/** Borrow character-owned data; the projection is not another stored copy. */
export function characterState(state: AgentRunState): CharacterState {
  const { lastReply, audienceExpired, ...conversation } = state.conversation;
  return {
    ...('usage' in state.task ? { usage: state.task.usage } : {}),
    conversation,
    ...('inbox' in state ? { inbox: state.inbox } : {}),
  };
}

/** Borrow execution data only. Clone explicitly when retaining a snapshot. */
export function taskExecutionState(state: AgentRunState): TaskExecutionState {
  const { usage, ...task } = state.task;
  const { exchanges, lastChatAt, ...conversation } = state.conversation;
  return {
    task,
    conversation,
    checkpoint: state.checkpoint,
    effects: state.effects,
    health: state.health,
  };
}

/** Assemble the existing public/archive shape without duplicating either owner. */
export function composeState(
  character: CharacterState,
  execution: TaskExecutionState,
): AgentRunState {
  return {
    version: 3,
    task: {
      ...execution.task,
      ...('usage' in character ? { usage: character.usage } : {}),
    },
    conversation: { ...character.conversation, ...execution.conversation },
    checkpoint: execution.checkpoint,
    effects: execution.effects,
    health: execution.health,
    ...('inbox' in character ? { inbox: character.inbox } : {}),
  };
}

/** Change only the execution; keep the character and the host's root reference. */
export function applyTaskExecutionState(
  state: AgentRunState,
  execution: TaskExecutionState,
  replace = false,
): void {
  if (replace) {
    const next = composeState(characterState(state), execution);
    state.task = next.task;
    state.conversation = next.conversation;
  } else {
    // Lease/control operations must not replace containers held by an active turn.
    for (const key of ['current', 'identity'] as const)
      if (key in execution.task)
        Object.assign(state.task, { [key]: execution.task[key] });
      else delete state.task[key];
    for (const key of ['lastReply', 'audienceExpired'] as const)
      if (key in execution.conversation)
        Object.assign(state.conversation, {
          [key]: execution.conversation[key],
        });
      else delete state.conversation[key];
  }
  state.checkpoint = execution.checkpoint;
  state.effects = execution.effects;
  state.health = execution.health;
}

/** Full transaction rollback, including character changes made by host hooks. */
export function restoreStateSnapshot(
  state: AgentRunState,
  snapshot: AgentRunState,
): void {
  for (const key of Object.keys(state))
    delete (state as Record<string, unknown>)[key];
  Object.assign(state, snapshot);
}
