import type { ToolState } from '../../contracts/tool-state';
import type { RequestBudget } from '../task/budget';

/**
 * Shared inputs for the decision-loop guards.
 *
 * Mirrors the fields `DecisionLoopOptions` already exposes, so the loop can pass
 * its current options directly instead of copying them into another object.
 */
export type DecisionBoundary = {
  state: ToolState;
  signal: AbortSignal;
  budget: Pick<RequestBudget, 'remainingMs'>;
  shouldYield(): boolean;
};

/** A tool call refused before execution; `terminate` asks the loop to end the batch. */
export type ToolBlock = {
  reason: string;
  terminate?: boolean;
};

/** Marks the current batch as failed so its remaining calls cannot execute. */
export function failBatch(state: ToolState) {
  state.hadError = true;
  state.skipBatch = true;
}

/** The run has nothing left to do: ended, unable to persist, stopped or yielded. */
export function turnStopped(boundary: DecisionBoundary): boolean {
  const { state, signal } = boundary;
  return (
    state.terminal ||
    state.persistenceFailed ||
    boundary.shouldYield() ||
    signal.aborted
  );
}

/** No further provider request may follow the completed assistant message. */
export function turnEnded(
  boundary: DecisionBoundary,
  stopReason: string,
): boolean {
  return (
    turnStopped(boundary) || stopReason === 'error' || stopReason === 'aborted'
  );
}

/**
 * Why the next tool call must be refused, in the loop's precedence order:
 * a truncated assistant message, then a stopped batch, then an exhausted budget.
 */
export function toolBlockReason(
  boundary: DecisionBoundary,
  truncated: boolean,
): ToolBlock | undefined {
  if (truncated) {
    // Current Pi versions fail truncated calls before this gate, so the batch is
    // usually marked by the tool_execution_end listener. Keep the refusal anyway:
    // a cut-off message must never execute tool calls, whatever the loop does.
    failBatch(boundary.state);
    return { reason: '模型输出被截断，整批未执行。' };
  }
  if (boundary.state.skipBatch || turnStopped(boundary))
    return { reason: '当前批次已停止。', terminate: true };
  if (boundary.budget.remainingMs <= 0)
    return { reason: '执行时间预算已耗尽。', terminate: true };
  return undefined;
}

/**
 * One accounted correction for local models that answer in prose after a tool
 * result. The nudge is spent on first use, so a second prose answer fails the
 * turn instead of being parsed as an action or replayed as a prior call.
 */
export class ToolProtocolCorrection {
  private spent = false;
  private pending = false;

  /** Whether the one correction is still available. */
  get available(): boolean {
    return !this.spent;
  }

  /** Spends the correction and queues its transcript message. */
  request() {
    if (this.spent) return;
    this.spent = true;
    this.pending = true;
  }

  /** Consumes the queued message when the next request context is built. */
  take(): boolean {
    const pending = this.pending;
    this.pending = false;
    return pending;
  }
}
