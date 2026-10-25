import type { ToolState } from '../../contracts/tool-state';
import type { Observation } from '../../contracts';
import { worldSignature } from '../../world/observe/extract';
import type { TaskService } from '../task/service';
import type { AgentRunState } from '../../contracts/state';
import { isEndedTask } from '../task/state';

/** Inputs for one completed decision turn. */
export type TurnHealthInput = {
  maxStalledTurns?: number;
  state: ToolState;
  attached: boolean;
  current: () => boolean;
  memory: AgentRunState;
  service: TaskService;
  hasMessage: boolean;
  launched: boolean;
  observation: Observation;
};

/**
 * Monitors execution health during decision turns:
 * - Detects consecutive tool errors within a single event loop
 * - Tracks lack of physical progress or repeated failures across turns
 * - Gracefully halts automatic retries by marking the task 'blocked'
 */
export class TurnHealthMonitor {
  private eventFailures = 0;

  recordTurn(input: TurnHealthInput) {
    const threshold = input.maxStalledTurns ?? 3;
    this.eventFailures = input.state.hadError ? this.eventFailures + 1 : 0;
    if (this.eventFailures >= threshold) {
      if (input.attached) input.memory.health.failures = this.eventFailures;
      this.blockTask(input, `连续 ${threshold} 轮工具失败，已停止本次事件。`);
      return;
    }
    if (input.hasMessage || input.launched || input.state.terminal) return;
    this.trackProgress(input, threshold);
  }

  /** Stops the current event and blocks its task when the caller may still own it. */
  private blockTask(input: TurnHealthInput, reason: string) {
    input.state.terminal = true;
    input.memory.health.lastResponse = reason;
    const task = input.memory.task.current;
    if (!input.attached || !input.current() || !task || isEndedTask(task))
      return;
    input.service.finish(input.service.lease(), { status: 'blocked', reason });
  }

  /** Counts failures and repeated world signatures across unattended task turns. */
  private trackProgress(input: TurnHealthInput, threshold: number) {
    const { memory } = input;
    memory.health.failures = input.state.hadError
      ? (memory.health.failures ?? 0) + 1
      : 0;
    const signature =
      worldSignature(input.observation, 'world') +
      JSON.stringify(input.observation.self);
    memory.health.noProgress =
      signature === memory.health.lastProgress
        ? (memory.health.noProgress ?? 0) + 1
        : 0;
    memory.health.lastProgress = signature;
    if (
      memory.health.failures < threshold &&
      memory.health.noProgress < threshold
    )
      return;
    input.service.finish(input.service.lease(), {
      status: 'blocked',
      reason: `连续 ${threshold} 轮失败或没有实际进展，已停止自动重试。`,
    });
    input.state.terminal = true;
  }
}
