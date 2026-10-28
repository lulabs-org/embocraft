import type { Message } from '@earendil-works/pi-ai';
import type { AICharacterTask } from '@voxel/shared';
import type { AgentRunState, PiCheckpoint } from '../../contracts/state';
import { isEndedTask } from '../task/state';
import { TaskService, type TaskLease } from '../task/service';
import { restoreActionEffects } from '../action/reconcile';
import { recentTurns } from './window';

/** Owner fields tie a checkpoint to exactly one task revision and audience. */
type CheckpointOwner = Pick<
  PiCheckpoint,
  'taskId' | 'revision' | 'taskStartedAt' | 'audience'
>;

/** Model-specific deserialization stays outside task policy and persisted state types. */
export function checkpointMessages(memory: AgentRunState): Message[] {
  return recentTurns((memory.checkpoint.pi?.messages ?? []) as Message[]);
}

/** Migrate both current and archived run states without replaying old tool calls. */
export function restoreCheckpoint(memory: AgentRunState) {
  restoreActionEffects(memory);
  const saved = memory.checkpoint.pi;
  if (saved?.inFlight)
    memory.checkpoint.unknownEffect = { ...saved.inFlight, state: 'unknown' };
  memory.version = 3;
  const task = memory.task.current;
  if (!task) {
    delete memory.checkpoint.pi;
    return;
  }
  const owner = checkpointOwner(new TaskService(memory).lease(), task);
  if (
    !saved ||
    ![2, 3].includes(saved.version) ||
    !matchesOwner(saved, owner)
  ) {
    delete memory.checkpoint.pi;
    return;
  }
  try {
    saved.messages = checkpointMessages(memory);
  } catch {
    delete memory.checkpoint.pi;
    return;
  }
  if (saved.inFlight) saved.inFlight.state = 'unknown';
}

/** Persists the trimmed transcript for the current task; callers redact first. */
export function updateCheckpoint(memory: AgentRunState, messages: Message[]) {
  const task = memory.task.current;
  if (!task || isEndedTask(task)) {
    delete memory.checkpoint.pi;
    return;
  }
  memory.checkpoint.pi = {
    version: 3,
    ...checkpointOwner(new TaskService(memory).lease(), task),
    messages: recentTurns(messages),
    inFlight: memory.checkpoint.pi?.inFlight,
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
