export type TaskLimits = {
  /** Missing on older saves means enabled. */
  enabled?: boolean;
  maxTurns: number;
  /** Consecutive failed or stalled turns before stopping; defaults to 3. */
  maxStalledTurns?: number;
  tokenBudget: number;
  taskTimeoutMs: number;
};

export const DEFAULT_TASK_LIMITS: TaskLimits = {
  maxTurns: 100,
  maxStalledTurns: 3,
  tokenBudget: 50000,
  taskTimeoutMs: 900000,
};

export type AICharacterTaskStatus =
  | 'running'
  | 'waiting'
  | 'needs_input'
  | 'blocked'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'budget';
export type AICharacterTask = {
  goal: string;
  status: AICharacterTaskStatus;
  summary: string;
  reason: string;
  owner?: string;
  privateTo?: string;
  calls: number;
  tokens: number;
  estimated: boolean;
  startedAt: number;
  elapsedMs: number;
  waitFor?: 'world' | 'players';
};
