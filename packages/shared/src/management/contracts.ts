import type { AICharacterSummary } from '../agent/characters';
import type { TaskPlan, TaskPlanState } from '../task/plans';
import type { TaskRun } from '../task/runs';
import type { TaskTiming } from '../task/timing';

export type TaskIdentity = { id: string; revision: number; startedAt: number };
export type ResourceMetadata = {
  resourceVersion: number;
  taskIdentity: TaskIdentity | null;
};
export type PublicAICharacterView = AICharacterSummary & ResourceMetadata;
export type PublicPlanView = TaskPlan & ResourceMetadata;
export type PublicRunView = TaskRun & ResourceMetadata;
export type PlanQueryFilter = {
  characterId?: string;
  offset?: number;
  search?: string;
  state?: TaskPlanState | 'unassigned';
  timing?: TaskTiming['kind'];
};
export type ManagementErrorData = {
  code: string;
  message: string;
  status: number;
};
export type CommandReceipt = {
  state: 'pending' | 'committed' | 'rejected' | 'unknown';
  result?: unknown;
  error?: ManagementErrorData;
};
export class ManagementError extends Error {
  constructor(
    message: string,
    readonly code = 'INVALID_REQUEST',
    readonly status = 400,
  ) {
    super(message);
  }
}

// A connection carries notifications only. Every reconnect prompts an HTTP refresh.
export const MANAGEMENT_EVENTS_VERSION = 3;
export const MAX_EVENT_REQUEST_BYTES = 32768;
export type ManagementChange = {
  resource: 'characters' | 'providers' | 'plans' | 'runs';
  characterIds?: string[];
  planIds?: string[];
  runIds?: string[];
};
export type ManagementEvent = {
  type: 'event';
  seq: number;
  event: 'snapshot' | 'changed';
  data: ManagementChange | null;
};
export type ManagementFrame =
  | { type: 'connected'; version: number }
  | ManagementEvent
  | { type: 'error'; error: ManagementErrorData };
