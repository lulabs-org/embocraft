import { paceChat } from './chat-pacing';
import { aiCharacterPermissions, key } from '@voxel/shared';
import type { AgentAction, AgentConfig, Observation } from '../../contracts';
import type { AgentSession } from '../../world/session/port';
import type { AgentRunState } from '../../contracts/state';
import { TaskService, type TaskLease } from '../task/service';
import type { AgentAttention } from '../../world/observe/attention';
import { withDeadline } from '../../kernel/abort';
import { executeBatch } from '../../world/actions/batch';
import { houseBlocks } from '../../world/actions/build';
import type { RequestBudget } from '../task/budget';

/**
 * Task-bound Action Execution Adapter:
 * Bridges runtime-level TaskService invariants, memory persistence, and budget limits
 * with the underlying physical batch executor (`executeBatch` in `actions/batch.ts`).
 *
 * Responsibilities:
 * - Guarantees session calls conform to the active `TaskLease`
 * - Merges and tracks unfinished blueprint builds across model turns
 * - Manages continuous follow pursuit state checkpoints
 * - Enforces task private routing for chat actions
 */
export async function executeTaskActions(
  session: AgentSession,
  actions: AgentAction[],
  observation: Observation,
  config: AgentConfig,
  signal: AbortSignal,
  memory: AgentRunState,
  budget: RequestBudget,
  lease: TaskLease,
  checkpoint: () => Promise<void>,
  attention?: AgentAttention,
  log: (message: string) => void = () => {},
) {
  const service = new TaskService(memory);
  service.assertCurrent(lease);
  signal.throwIfAborted();
  const guardedSession: AgentSession = {
    observe: () => {
      service.assertCurrent(lease);
      return session.observe();
    },
    move: (x, z, jump) => {
      if (x || z || jump) service.assertCurrent(lease);
      session.move(x, z, jump);
    },
    request: (type, payload) => {
      service.assertCurrent(lease);
      return session.request(type, payload);
    },
  };
  const task = memory.task.current!;
  const routed = actions.map(
    (action): AgentAction =>
      action.type === 'chat' && task.privateTo
        ? { ...action, scope: 'private', recipients: [task.privateTo] }
        : action,
  );
  const deadline = withDeadline(signal, budget.remainingMs, 'task_timeout');
  let outcome;
  // Keep older unfinished coordinates when a new batch only works on a subset.
  const priorBuild = memory.effects.unfinishedBuild;
  const followControl = { pursuing: true };
  try {
    outcome = await executeBatch(
      guardedSession,
      routed,
      observation,
      aiCharacterPermissions(config),
      deadline.signal,
      {
        navigation: { follow: followControl },
        pending: () => !!attention?.pending,
        log,
        beforeAction: async (action) => {
          service.assertCurrent(lease);
          signal.throwIfAborted();
          if (action.type === 'chat') await paceChat(memory, signal);
          if (action.type === 'follow') {
            memory.effects.follow = {
              action,
              taskStartedAt: task.startedAt,
              pursuing: true,
            };
            await checkpoint();
          }
          if (action.type === 'goto') delete memory.effects.follow;
          if (action.type === 'build' || action.type === 'house') {
            const blocks =
              action.type === 'house' ? houseBlocks(action) : action.blocks;
            const extra =
              priorBuild?.result.remaining.filter(
                (b) => !blocks.some((p) => key(p) === key(b)),
              ) ?? [];
            memory.effects.unfinishedBuild = {
              action,
              result: {
                ok: false,
                total: blocks.length + extra.length,
                completed: 0,
                skipped: 0,
                remaining: [...extra, ...blocks],
                failures: [],
                note: '执行中；未确认的动作不会自动重放。',
              },
            };
            await checkpoint();
          }
        },
        buildCheckpoint: (action, result) => {
          service.assertCurrent(lease);
          const blocks =
            action.type === 'house' ? houseBlocks(action) : action.blocks;
          const extra =
            priorBuild?.result.remaining.filter(
              (b) => !blocks.some((p) => key(p) === key(b)),
            ) ?? [];
          const merged = {
            ...result,
            remaining: [...extra, ...result.remaining],
            ok: result.ok && !extra.length,
            total: result.total + extra.length,
            uncertain: [
              ...(priorBuild?.result.uncertain?.filter((b) =>
                extra.some((p) => key(p) === key(b)),
              ) ?? []),
              ...(result.uncertain ?? []),
            ],
          };
          memory.effects.unfinishedBuild = merged.ok
            ? undefined
            : { action, result: merged };
        },
        checkpoint: async (batch) => {
          service.assertCurrent(lease);
          memory.effects.previous = batch;
          // Confirmed individual edits can also finish part of an older blueprint.
          if (memory.effects.unfinishedBuild) {
            memory.effects.unfinishedBuild.result.remaining =
              memory.effects.unfinishedBuild.result.remaining.filter(
                (b) =>
                  !batch.results.some(
                    (r) =>
                      r.status === 'succeeded' &&
                      r.action.type === 'edit' &&
                      key(r.action) === key(b) &&
                      r.action.material === b.material,
                  ),
              );
            if (!memory.effects.unfinishedBuild.result.remaining.length)
              memory.effects.unfinishedBuild = undefined;
          }
          await checkpoint();
        },
      },
    );
  } finally {
    deadline.clear();
  }
  service.assertCurrent(lease);
  const { batch, observation: finalObservation } = outcome;
  const followResult = batch.results.find(
    (r) => r.action.type === 'follow',
  )?.result;
  if (memory.effects.follow && followResult && 'status' in followResult) {
    memory.effects.follow.pursuing = followControl.pursuing;
    memory.effects.follow.lastResult = followResult;
    if (!followResult.ok) delete memory.effects.follow;
  }
  if (deadline.expired || budget.remainingMs <= 0) {
    batch.stopReason = 'timeout';
    batch.ok = false;
  }
  memory.effects.previous = batch;
  if (batch.ok) delete memory.health.decisionError;
  await checkpoint();
  signal.throwIfAborted();
  return { batch, observation: finalObservation };
}
