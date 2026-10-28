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

/** Task identity and progress belong to a single execution. */
export type TaskSection = {
  current?: AICharacterTask;
  identity?: { id: string; revision: number; startedAt: number };
};

export type CharacterConversation = {
  exchanges?: Record<string, unknown[]>;
  lastChatAt?: number;
};

export type ExecutionConversation = {
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
  conversation: CharacterConversation;
  inbox?: { version: 1; events: CharacterEvent[] };
};

/** One task execution. Task policy cannot access character history, usage or inbox. */
export type TaskExecutionState = {
  task: TaskSection;
  conversation: ExecutionConversation;
  checkpoint: CheckpointSection;
  effects: EffectsSection;
  health: HealthSection;
};

/** Native runtime state; the stored schema has the same ownership boundaries. */
export type RuntimeState = {
  version: 4;
  character: CharacterState;
  execution: TaskExecutionState;
};

export function emptyExecutionState(): TaskExecutionState {
  return {
    task: {},
    conversation: {},
    checkpoint: {},
    effects: {},
    health: {},
  };
}

export function emptyState(): RuntimeState {
  return {
    version: 4 as const,
    character: { conversation: {} },
    execution: emptyExecutionState(),
  };
}

/** The ledger accounts for character usage separately from an execution archive. */
export function snapshotState(state: RuntimeState): RuntimeState {
  const copy = structuredClone(state);
  delete copy.character.usage;
  return copy;
}

export type PiCheckpoint = {
  version: 3;
  taskId: string;
  revision: number;
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
