import type {
  AICharacterPermissions,
  AICharacterSkillId,
} from './capabilities';
import type { TaskLimits, AICharacterTask } from '../task/contracts';
export const AI_CHARACTER_ROLE_DESCRIPTION_LIMIT = 2000;

export type AICharacterSettings = {
  providerId: string;
  model: string;
  name: string;
  goal: string;
  /** Persistent identity, responsibilities and style, independent of a task. */
  roleDescription?: string;
  /** Legacy compatibility only; task continuation is decided from progress. */
  continuous: boolean;
  /** Whether execution limits are enabled for this role. Missing means enabled. */
  taskLimitsEnabled?: boolean;
  /** Maximum model calls per task, not a target number of turns. */
  maxTurns: number;
  /** Consecutive failed or stalled turns before stopping; defaults to 3. */
  maxStalledTurns?: number;
  tokenBudget?: number;
  taskTimeoutMs?: number;
  intervalMode: 'fixed' | 'random';
  intervalMinMs: number;
  intervalMaxMs: number;
  intervalMs: number;
  timeoutMs: number;
  maxTokens: number;
  /** @deprecated Legacy input; use permissions for independent action control. */
  allowEdits?: boolean;
  /** Canonical permissions; absent only in legacy configurations. */
  permissions?: AICharacterPermissions;
  skills?: AICharacterSkillId[];
  voiceReplies?: boolean;
  voiceServiceId?: string;
  thinking: 'enabled' | 'disabled';
  reasoningEffort: 'none' | 'low' | 'high' | 'max';
};
export const AI_CHARACTER_LOG_LIMIT = 500;
/** Default page size for the paginated activity-log endpoint. */
export const AI_CHARACTER_LOG_PAGE_SIZE = 50;
/** Upper bound accepted for a single activity-log page request. */
export const AI_CHARACTER_LOG_MAX_PAGE_SIZE = 200;

/** One activity-log entry; `time` is UTC epoch milliseconds, null when the legacy record has no recorded time. */
export type AICharacterLogEntry = {
  /** UTC epoch milliseconds; null means the legacy timestamp is unknown. */
  time: number | null;
  text: string;
};

export type AICharacterUsage = {
  calls: number;
  tokens: number;
  estimated: boolean;
};
export type AICharacterView = AICharacterSettings & {
  voiceServiceName?: string;
  id: string;
  providerName: string;
  status:
    | 'joining'
    | 'running'
    | 'idle'
    | 'stopping'
    | 'stopped'
    | 'completed'
    | 'failed';
  createdAt: number;
  sessionId?: string;
  /**
   * Full activity log, oldest-first. Internal/persisted shape only: the
   * `/ai-characters` list and detail responses omit this and expose `lastLog`;
   * the complete history is served by `GET /ai-characters/{id}/logs`.
   */
  logEntries: AICharacterLogEntry[];
  task?: AICharacterTask;
  /** Limits of the current execution, which may differ from role defaults. */
  taskExecution?: {
    runId: string;
    limits: TaskLimits;
    source?: string;
    action?: { id: string; name: string; status: string };
  };
  queuedTasks?: {
    id: string;
    goal: string;
    scheduledAt: number;
    coalescedTriggers: number;
  }[];
  usage?: AICharacterUsage;
  lastResponse?: string;
  /** The original private recipient no longer exists; the task must be reassigned. */
  taskRequiresReassignment?: boolean;
};

/**
 * Public HTTP shape for `GET /ai-characters` and `GET /ai-characters/{id}`.
 * Omits the heavy `logEntries` array and carries only the newest log line so
 * summary cards stay small; the full history lives behind `GET /ai-characters/{id}/logs`.
 */
export type AICharacterSummary = Omit<AICharacterView, 'logEntries'> & {
  /** Newest activity-log text, if any. */
  lastLog?: string;
  /** UTC epoch milliseconds of the newest activity-log entry; null when unrecorded. */
  lastLogAt?: number | null;
};

/** A page of activity-log entries, newest-first, for `GET /ai-characters/{id}/logs`. */
export type AICharacterLogPage = {
  entries: AICharacterLogEntry[];
  /** Opaque cursor to request the next (older) page; absent when exhausted. */
  nextCursor?: string;
  /** Total entries retained for the character, for display only. */
  total: number;
};
