import type { Message } from '@earendil-works/pi-ai';
import type { AgentRunState } from '../../contracts/state';
import { restoreBatchHistory } from '../task/state';
import { TaskService } from '../task/service';
import { recentTurns } from './window';

/** Model-specific deserialization stays outside task policy and persisted state types. */
export function checkpointMessages(memory: AgentRunState): Message[] {
  return recentTurns((memory.checkpoint.pi?.messages ?? []) as Message[]);
}

/** Migrate both current and archived run states without replaying old tool calls. */
export function restoreCheckpoint(memory: AgentRunState) {
  const previous = restoreBatchHistory(memory.effects.previous);
  memory.effects.previous = previous;
  if (memory.effects.pendingEffects)
    memory.effects.pendingEffects = restoreBatchHistory(
      memory.effects.pendingEffects,
    );
  if (
    !memory.effects.pendingEffects &&
    previous?.results?.some((r) => r.status === 'unknown')
  )
    memory.effects.pendingEffects = structuredClone(previous);
  const saved = memory.checkpoint.pi;
  if (saved?.inFlight)
    memory.checkpoint.unknownEffect = { ...saved.inFlight, state: 'unknown' };
  if (!memory.task.current) {
    delete memory.checkpoint.pi;
    memory.version = 3;
    return;
  }
  const identity = new TaskService(memory).lease();
  if (
    !saved ||
    ![2, 3].includes(saved.version) ||
    saved.taskId !== identity.id ||
    saved.revision !== identity.revision ||
    saved.taskStartedAt !== memory.task.current.startedAt ||
    saved.audience !== (memory.task.current.privateTo ?? 'public')
  ) {
    delete memory.checkpoint.pi;
  } else {
    try {
      saved.messages = checkpointMessages(memory);
    } catch {
      delete memory.checkpoint.pi;
    }
    if (saved.inFlight) saved.inFlight.state = 'unknown';
  }
  memory.version = 3;
}

export function updateCheckpoint(
  memory: AgentRunState,
  messages: Message[],
  apiKey?: string,
) {
  if (
    !memory.task.current ||
    ['completed', 'cancelled'].includes(memory.task.current.status)
  ) {
    delete memory.checkpoint.pi;
    return;
  }
  const identity = new TaskService(memory).lease();
  memory.checkpoint.pi = {
    version: 3,
    taskId: identity.id,
    revision: identity.revision,
    taskStartedAt: memory.task.current.startedAt,
    audience: memory.task.current.privateTo ?? 'public',
    messages: recentTurns(messages),
    inFlight: memory.checkpoint.pi?.inFlight,
  };
  if (apiKey)
    memory.checkpoint.pi = JSON.parse(
      JSON.stringify(memory.checkpoint.pi).split(apiKey).join('[已隐藏]'),
    );
}
