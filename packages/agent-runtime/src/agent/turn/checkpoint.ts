import type { Message } from '@earendil-works/pi-ai';
import type { AICharacterTask } from '@voxel/shared';
import type { PiCheckpoint, RuntimeState } from '../../contracts/state';
import type { TaskLease } from '../../contracts/task';
import { restoreActionEffects } from '../action/reconcile';
import { TaskService } from '../task/service';
import { isEndedTask } from '../task/state';
import { recentTurns } from './window';

/** Owner fields tie a checkpoint to exactly one task revision and audience. */
type CheckpointOwner = Pick<
  PiCheckpoint,
  'taskId' | 'revision' | 'taskStartedAt' | 'audience'
>;

/** Model-specific deserialization stays outside task policy and persisted state types. */
export function checkpointMessages(memory: RuntimeState): Message[] {
  return recentTurns(
    (memory.execution.checkpoint.pi?.messages ?? []) as Message[],
  );
}

/** Migrate both current and archived run states without replaying old tool calls. */
export function restoreCheckpoint(memory: RuntimeState) {
  restoreActionEffects(memory);
  const saved = memory.execution.checkpoint.pi;
  if (saved?.inFlight)
    memory.execution.checkpoint.unknownEffect = {
      ...saved.inFlight,
      state: 'unknown',
    };
  const task = memory.execution.task.current;
  if (!task) {
    delete memory.execution.checkpoint.pi;
    return;
  }
  const owner = checkpointOwner(new TaskService(memory).lease(), task);
  if (!saved || saved.version !== 3 || !matchesOwner(saved, owner)) {
    delete memory.execution.checkpoint.pi;
    return;
  }
  try {
    saved.messages = checkpointMessages(memory);
  } catch {
    delete memory.execution.checkpoint.pi;
    return;
  }
  if (saved.inFlight) saved.inFlight.state = 'unknown';
}

/** Persists the trimmed transcript for the current task; callers redact first. */
export function updateCheckpoint(memory: RuntimeState, messages: Message[]) {
  const task = memory.execution.task.current;
  if (!task || isEndedTask(task)) {
    delete memory.execution.checkpoint.pi;
    return;
  }
  memory.execution.checkpoint.pi = {
    version: 3,
    ...checkpointOwner(new TaskService(memory).lease(), task),
    messages: recentTurns(messages),
    inFlight: memory.execution.checkpoint.pi?.inFlight,
  };
}

function checkpointOwner(
  lease: TaskLease,
  task: AICharacterTask,
): CheckpointOwner {
  return {
    taskId: lease.id,
    revision: lease.revision,
    taskStartedAt: task.startedAt,
    audience: task.privateTo ?? 'public',
  };
}

function matchesOwner(saved: PiCheckpoint, owner: CheckpointOwner): boolean {
  return (
    saved.taskId === owner.taskId &&
    saved.revision === owner.revision &&
    saved.taskStartedAt === owner.taskStartedAt &&
    saved.audience === owner.audience
  );
}
