import type { WorldEvent } from '@voxel/shared';

export type TaskCommand =
  | { type: 'start'; goal: string }
  | { type: 'revise'; goal: string }
  | { type: 'pause' | 'resume' | 'cancel' };
export type TaskAuthority =
  | { kind: 'operator' }
  | { kind: 'player'; message: WorldEvent };
export type TaskLease = { id: string; revision: number; startedAt: number };
export type TaskOutcome =
  | { status: 'completed' | 'blocked' | 'needs_input'; reason: string }
  | {
      status: 'waiting';
      reason: string;
      waitFor: 'world' | 'players';
      signature: string;
    };
