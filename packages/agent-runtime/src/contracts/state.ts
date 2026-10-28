import type {
  AICharacterTask,
  AICharacterUsage,
  WorldEvent,
} from '@voxel/shared';
import type {
  BatchResult,
  BuildAction,
  BuildResult,
  NavigationResult,
} from './action';

export type ActiveAction = {
  id: string;
  name: string;
  taskId: string;
  revision: number;
  status:
    | 'running'
    | 'completed'
    | 'failed'
    | 'unknown'
    | 'paused'
    | 'cancelled';
  result?: unknown;
};

export type FollowIntent = {
  action: { type: 'follow'; playerId: string; distance: number };
  taskStartedAt: number;
  pursuing: boolean;
  stalledSlices?: number;
  lastResult?: NavigationResult;
};

/** Legacy task partition; usage belongs to the character, current/identity to execution. */
export type TaskSection = {
  current?: AICharacterTask;
  identity?: { id: string; revision: number; startedAt: number };
  usage?: AICharacterUsage;
};

/** Legacy conversation partition; audienceExpired/lastReply are execution-local. */
export type ConversationSection = {
  exchanges?: Record<string, unknown[]>;
  lastChatAt?: number;
  lastReply?: BatchResult;
  audienceExpired?: boolean;
};

/** Checkpoint partition: model transcript and unconfirmed effects. */
export type CheckpointSection = {
  pi?: PiCheckpoint;
  unknownEffect?: { id: string; name: string; state: 'unknown' };
};

/** Effects partition: world writes that may need reconciliation. */
export type EffectsSection = {
  previous?: unknown;
  pendingEffects?: BatchResult;
  unfinishedBuild?: { action: BuildAction; result: BuildResult };
  follow?: FollowIntent;
  activeAction?: ActiveAction;
};

/** Health partition: bounded retry and stall counters. */
export type HealthSection = {
  waitSignature?: string;
  failures?: number;
  noProgress?: number;
  lastProgress?: string;
  lastResponse?: string;
  decisionError?: string;
};

/** Character lifetime: survives the creation and completion of task executions. */
export type CharacterState = {
  usage?: AICharacterUsage;
  conversation: Pick<ConversationSection, 'exchanges' | 'lastChatAt'>;
  inbox?: { version: 1; events: CharacterEvent[] };
};

/** One task execution. Task policy cannot access character history, usage or inbox. */
export type TaskExecutionState = {
  task: Omit<TaskSection, 'usage'>;
  conversation: Pick<ConversationSection, 'lastReply' | 'audienceExpired'>;
  checkpoint: CheckpointSection;
  effects: EffectsSection;
  health: HealthSection;
};

/**
 * Public v3 compatibility shape. Character and execution state share this wire
 * format, but lifecycle operations use their separate ownership projections.
 */
export type AgentRunState = {
  version?: 3;
  task: TaskSection;
  conversation: ConversationSection;
  checkpoint: CheckpointSection;
  effects: EffectsSection;
  health: HealthSection;
  inbox?: { version: 1; events: CharacterEvent[] };
};

export function emptyState(): AgentRunState {
  return {
    version: 3,
    task: {},
    conversation: {},
    checkpoint: {},
    effects: {},
    health: {},
  };
}

/** Archived run snapshots exclude usage; the task ledger accounts for it separately. */
export function snapshotState(state: AgentRunState): AgentRunState {
  const copy = structuredClone(state);
  delete copy.task.usage;
  return copy;
}

export type PiCheckpoint = {
  version: 1 | 2 | 3;
  taskId?: string;
  revision?: number;
  taskStartedAt: number;
  audience: string;
  /** Opaque adapter data; only the Pi boundary interprets model messages. */
  messages: unknown[];
  inFlight?: { id: string; name: string; state: 'executing' | 'unknown' };
};

/** Durable input/result envelope; content never grants authority. */
export type CharacterEvent = {
  id: string;
  kind: 'chat' | 'plan' | 'action_result' | 'control';
  state: 'pending' | 'processing' | 'done' | 'unknown';
  at: number;
  audience: string;
  actor?: string;
  runId?: string;
  planId?: string;
  characterId?: string;
  taskId?: string;
  revision?: number;
  actionId?: string;
  message?: WorldEvent;
  detail?: string;
};
