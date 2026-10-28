import { randomUUID } from 'node:crypto';
import {
  CHAT_PACE_INTERVAL_MS,
  type AICharacterPermissions,
} from '@voxel/shared';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AgentAction,
  BatchResult,
  BuildAction,
  BuildResult,
  Observation,
} from '../../contracts';
import type { AgentSession } from '../../world/session/port';
import { cancellable } from '../../kernel/abort';
import { executeAction } from './execute';
import { parseActions } from './parse';
import type { NavigationOptions } from '../nav/controller';

export type BatchOptions = {
  navigation?: NavigationOptions;
  pending?: (index: number) => boolean;
  checkpoint?: (batch: BatchResult) => unknown | Promise<unknown>;
  buildCheckpoint?: (
    action: BuildAction,
    result: BuildResult,
  ) => unknown | Promise<unknown>;
  beforeAction?: (action: AgentAction) => unknown | Promise<unknown>;
  log?: (message: string) => unknown | Promise<unknown>;
};

/**
 * Low-level Physical Batch Execution Engine:
 * Sequences and dispatches atomic AgentAction commands against the world Session,
 * handling physical step verification, movement stalling checks, and observation refreshing.
 * Does not depend on high-level TaskService, lease validation, or AgentRunState.
 */
export async function executeBatch(
  session: AgentSession,
  actions: AgentAction[],
  initial: Observation,
  permissions: AICharacterPermissions,
  signal: AbortSignal,
  options: BatchOptions = {},
): Promise<{ batch: BatchResult; observation: Observation }> {
  // Defense in depth at the effect boundary, including an invalid final action.
  actions = parseActions(actions, permissions);
  const batch: BatchResult = {
    batchId: randomUUID(),
    actions,
    results: actions.map((action) => ({ action, status: 'pending' })),
    remaining: [...actions],
    ok: false,
    stopReason: 'executing',
  };
  let observation = initial;
  let lastChat = 0;
  const log = options.log ?? (() => {});
  const save = async () => {
    batch.remaining = batch.results
      .filter((r) => r.status === 'pending')
      .map((r) => r.action);
    await options.checkpoint?.(structuredClone(batch));
  };
  await save();
  for (const [index, entry] of batch.results.entries()) {
    if (signal.aborted) {
      batch.stopReason = 'aborted';
      break;
    }
    if (options.pending?.(index)) {
      batch.stopReason = 'message';
      break;
    }
    const action = entry.action;
    let awaitingEffect = false;
    let phase: 'before' | 'execute' | 'observe' = 'before';
    const guarded: AgentSession = {
      observe: () => {
        signal.throwIfAborted();
        return cancellable(session.observe(), signal);
      },
      move: (x, z, jump) => {
        // Always permit the final stop input after cancellation.
        if (x || z || jump) signal.throwIfAborted();
        session.move(x, z, jump);
      },
      request: async <T>(type: string, payload?: unknown): Promise<T> => {
        signal.throwIfAborted();
        awaitingEffect = type !== 'observe';
        const result = await cancellable(
          session.request<T>(type, payload),
          signal,
        );
        awaitingEffect = false;
        return result;
      },
    };
    try {
      if (action.type === 'chat' && lastChat) {
        await delay(
          Math.max(0, CHAT_PACE_INTERVAL_MS - (Date.now() - lastChat)),
          undefined,
          { signal },
        );
        if (options.pending?.(index)) {
          batch.stopReason = 'message';
          break;
        }
      }
      signal.throwIfAborted();
      await options.beforeAction?.(action);
      entry.startedAt = Date.now();
      entry.status = 'executing';
      entry.before = {
        x: observation.self.x,
        y: observation.self.y,
        z: observation.self.z,
      };
      await save();
      log(`第 ${index + 1}/${actions.length} 个动作：${action.type}`);
      phase = 'execute';
      entry.result = await executeAction(
        guarded,
        action,
        observation,
        permissions,
        signal,
        log,
        async (result) => {
          entry.result = result;
          if (action.type === 'build' || action.type === 'house')
            await options.buildCheckpoint?.(action, result);
          await save();
        },
        {
          ...options.navigation,
          shouldYield: () => !!options.pending?.(index),
        },
      );
      if (action.type === 'chat') lastChat = Date.now();
      entry.status = entry.result.ok ? 'succeeded' : 'failed';
      await save();
      if (
        ['move', 'goto', 'follow', 'edit', 'build', 'house'].includes(
          action.type,
        )
      ) {
        phase = 'observe';
        const fresh = await guarded.observe();
        // Never introduce raw historical chat into this decision's audience.
        observation = {
          ...fresh,
          events: initial.events,
          attention: initial.attention,
        };
        entry.after = { x: fresh.self.x, y: fresh.self.y, z: fresh.self.z };
        if (
          action.type === 'move' &&
          (action.x || action.z || action.jump) &&
          Math.hypot(
            entry.after.x - entry.before.x,
            entry.after.y - entry.before.y,
            entry.after.z - entry.before.z,
          ) < 0.05
        ) {
          entry.status = 'failed';
          entry.result = {
            ok: false,
            note: '未观察到有效移动；不代表到达目标。',
          };
          batch.stopReason = 'movement_stalled';
          break;
        }
      }
      if (!entry.result.ok) {
        batch.stopReason = 'failed';
        break;
      }
      if (
        action.type === 'goto' &&
        'status' in entry.result &&
        entry.result.status === 'progress'
      ) {
        entry.status = 'interrupted';
        batch.stopReason = 'message';
        break;
      }
      await save();
    } catch {
      if (awaitingEffect) {
        entry.status = 'unknown';
        batch.stopReason = 'unknown';
      } else if (phase === 'observe') {
        // Preserve the acknowledged effect, but do not continue on stale observations.
        batch.stopReason = signal.aborted ? 'aborted' : 'observation_failed';
      } else {
        if (entry.status === 'executing')
          entry.status = signal.aborted ? 'interrupted' : 'failed';
        batch.stopReason = signal.aborted ? 'aborted' : 'failed';
      }
      break;
    }
  }
  if (batch.stopReason === 'executing') {
    batch.ok = batch.results.every((r) => r.status === 'succeeded');
    batch.stopReason = batch.ok ? 'completed' : 'failed';
  }
  await save();
  log(
    `批次${batch.ok ? '完成' : '中断'}：${batch.stopReason} · 剩余 ${batch.remaining.length} 个动作`,
  );
  return { batch, observation };
}
