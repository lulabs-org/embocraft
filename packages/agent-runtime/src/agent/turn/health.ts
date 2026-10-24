import type { ToolState } from '../../contracts/tool-state';
import type { Observation } from '../../contracts';
import { worldSignature } from '../../world/observe/extract';
import type { TaskService } from '../task/service';
import type { AgentRunState } from '../../contracts/state';

/**
 * Monitors execution health during decision turns:
 * - Detects consecutive tool errors within a single event loop
 * - Tracks lack of physical progress or repeated failures across turns
 * - Gracefully halts automatic retries by marking the task 'blocked'
 */
export class TurnHealthMonitor {
  private eventFailures = 0;

  recordTurn(o: {
    maxStalledTurns?: number;
    state: ToolState;
    attached: boolean;
    current: () => boolean;
    memory: AgentRunState;
    service: TaskService;
    hasMessage: boolean;
    launched: boolean;
    observation: Observation;
  }) {
    const threshold = o.maxStalledTurns ?? 3;
    this.eventFailures = o.state.hadError ? this.eventFailures + 1 : 0;
    if (this.eventFailures >= threshold) {
      if (o.attached) o.memory.health.failures = this.eventFailures;
      o.state.terminal = true;
      o.memory.health.lastResponse = `连续 ${threshold} 轮工具失败，已停止本次事件。`;
      if (
        o.attached &&
        o.current() &&
        o.memory.task.current &&
        !['completed', 'cancelled'].includes(o.memory.task.current.status)
      ) {
        o.service.finish(o.service.lease(), {
          status: 'blocked',
          reason: o.memory.health.lastResponse,
        });
      }
      return;
    }
    if (o.hasMessage || o.launched || o.state.terminal) return;
    o.memory.health.failures = o.state.hadError
      ? (o.memory.health.failures ?? 0) + 1
      : 0;
    const signature =
      worldSignature(o.observation, 'world') +
      JSON.stringify(o.observation.self);
    o.memory.health.noProgress =
      signature === o.memory.health.lastProgress
        ? (o.memory.health.noProgress ?? 0) + 1
        : 0;
    o.memory.health.lastProgress = signature;
    if (
      o.memory.health.failures >= threshold ||
      o.memory.health.noProgress >= threshold
    ) {
      o.service.finish(o.service.lease(), {
        status: 'blocked',
        reason: `连续 ${threshold} 轮失败或没有实际进展，已停止自动重试。`,
      });
      o.state.terminal = true;
    }
  }
}
