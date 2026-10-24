import { withDeadline } from '../../kernel/abort';
import { recordEvent } from '../task/inbox';
import { TaskService } from '../task/service';
import { aiCharacterPermissions } from '@voxel/shared';
import { navigate, observeNavigation } from '../../world/nav/controller';
import { parseAction } from '../../world/actions/parse';
import type { AgentConfig } from '../../contracts';
import type { AgentSession } from '../../world/session/port';
import type { AgentRunState } from '../../contracts/state';
import type { AgentAttention } from '../../world/observe/attention';
type FollowOptions = {
  memory: AgentRunState;
  session: AgentSession;
  signal: AbortSignal;
  config: AgentConfig;
  attention?: AgentAttention;
  checkpoint?: () => void | Promise<void>;
};

/** A bounded host tick: no model request, no new task, no replayed movement inputs. */
export async function runFollowStep(options: FollowOptions) {
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
        recordEvent(memory, {
          id: `action:${action.id}:${lease.revision}`,
          kind: 'action_result',
          state: 'pending',
          at: Date.now(),
          audience: task.privateTo ?? 'public',
          taskId: lease.id,
          revision: lease.revision,
          actionId: action.id,
          detail: task.reason,
        });
      }
      await options.checkpoint?.();
    }
  }
}
