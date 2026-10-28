import { withDeadline } from '../../kernel/abort';
import {
  markActiveActionRunning,
  recordActionResult,
  settleActiveAction,
} from './lifecycle';
import type { ActionRunOptions, ContinuingAction } from './port';
import type { AgentAction, BatchResult, Observation } from '../../contracts';
import type { TaskLease } from '../task/service';
import { worldSignature } from '../../world/observe/extract';
import type { ToolState } from '../../contracts/tool-state';
import { TaskService } from '../task/service';
import { aiCharacterPermissions } from '@voxel/shared';
import { navigate, observeNavigation } from '../../world/nav/controller';
import { parseAction } from '../../world/actions/parse';
import type { AgentRunState } from '../../contracts/state';

/** A bounded host tick: no model request, no new task, no replayed movement inputs. */
export async function runFollowStep(options: ActionRunOptions) {
  const { memory, session, signal, config, attention } = options;
  const follow = memory.effects.follow,
    task = memory.task.current;
  if (!follow || !task || follow.taskStartedAt !== task.startedAt) {
    delete memory.effects.follow;
    return;
  }
  const service = new TaskService(memory);
  const lease = service.lease();
  if (memory.effects.activeAction?.name === 'follow')
    Object.assign(memory.effects.activeAction, {
      revision: lease.revision,
      status: 'running',
    });
  const started = Date.now();
  const remaining = (config.taskTimeoutMs ?? 900000) - task.elapsedMs;
  const deadline = withDeadline(signal, remaining, 'task_timeout');
  const active = deadline.signal;
  try {
    // Revalidate persisted intent and current permission before every slice.
    parseAction(follow.action, aiCharacterPermissions(config));
    await options.checkpoint?.();
    const observation = await observeNavigation(session, active);
    active.throwIfAborted();
    const result = await navigate(session, follow.action, observation, active, {
      durationMs: 1500,
      follow,
      shouldYield: () => !!attention?.pending,
    });
    service.assertCurrent(lease);
    follow.lastResult = result;
    const moved = Math.hypot(
      result.position.x - observation.self.x,
      result.position.y - observation.self.y,
      result.position.z - observation.self.z,
    );
    follow.stalledSlices =
      result.status === 'progress' && moved < 0.08 && !attention?.pending
        ? (follow.stalledSlices ?? 0) + 1
        : 0;
    if (follow.stalledSlices >= 3) {
      result.ok = false;
      result.status = 'failed';
      result.code = 'stalled';
      result.note = '连续三次跟随没有移动进展，已停止。';
    }
    task.summary = result.note;
    task.reason = result.code ?? '';
    if (!result.ok && result.code !== 'target_not_visible') {
      task.status = 'blocked';
    } else {
      task.status = 'waiting';
      task.waitFor = 'players';
    }
    memory.health.noProgress = 0;
  } catch (error) {
    if (!signal.aborted && service.current(lease)) {
      task.status = deadline.expired ? 'budget' : 'blocked';
      task.reason = deadline.expired
        ? '跟随任务执行时间预算已耗尽。'
        : error instanceof Error
          ? error.message
          : '跟随执行失败，已停止。';
    }
  } finally {
    deadline.clear();
    session.move(0, 0, false);
    if (service.current(lease)) {
      task.elapsedMs += Date.now() - started;
      if (
        task.elapsedMs >= (config.taskTimeoutMs ?? 900000) &&
        !signal.aborted
      ) {
        task.status = 'budget';
        task.reason = '跟随任务执行时间预算已耗尽。';
      }
      if (
        task.status === 'blocked' &&
        memory.effects.activeAction?.name === 'follow'
      ) {
        const action = memory.effects.activeAction;
        action.status = 'failed';
        action.result = follow.lastResult ?? task.reason;
        settleActiveAction(memory, service, lease, action);
        recordActionResult(memory, service, lease, action.id, {
          id: `action:${action.id}:${lease.revision}`,
          detail: task.reason,
        });
      }
      await options.checkpoint?.();
    }
  }
}

/** The action layer owns both local continuation and its recovery decision. */
export const followingAction: ContinuingAction = {
  pending: (memory) => !!memory.effects.follow,
  wakeDelayMs: 100,
  async advance(options) {
    await runFollowStep(options);
    const { memory } = options;
    const task = memory.task.current;
    if (
      task?.status === 'blocked' &&
      memory.effects.activeAction?.status === 'failed'
    ) {
      delete memory.effects.follow;
      task.status = 'running';
      return 'resume';
    }
    return 'stop';
  },
};

/** Per-batch intent tracking; navigation to a destination supersedes following. */
export function createFollowEffects(memory: AgentRunState) {
  const control = { pursuing: true };
  return {
    control,
    before(action: AgentAction): boolean {
      if (action.type === 'goto') delete memory.effects.follow;
      if (action.type !== 'follow') return false;
      memory.effects.follow = {
        action,
        taskStartedAt: memory.task.current!.startedAt,
        pursuing: true,
      };
      return true;
    },
    complete(batch: BatchResult) {
      const result = batch.results.find(
        (r) => r.action.type === 'follow',
      )?.result;
      if (memory.effects.follow && result && 'status' in result) {
        memory.effects.follow.pursuing = control.pursuing;
        memory.effects.follow.lastResult = result;
        if (!result.ok) delete memory.effects.follow;
      }
    },
  };
}

/** A successful first slice parks the task; later slices run without a model. */
export function settleFollowing(
  memory: AgentRunState,
  service: TaskService,
  lease: TaskLease,
  observation: Observation,
  state: ToolState,
) {
  if (!memory.effects.follow) return;
  service.finish(lease, {
    status: 'waiting',
    reason: '持续跟随中，由本地导航控制器推进。',
    waitFor: 'players',
    signature: worldSignature(observation, 'players'),
  });
  state.terminal = true;
}

/** Retain the original checkpoint order: the first slice is saved before activation. */
export function activateFollowing(
  memory: AgentRunState,
  id: string,
  lease: TaskLease,
) {
  if (memory.effects.follow)
    markActiveActionRunning(memory, id, 'follow', lease);
}
