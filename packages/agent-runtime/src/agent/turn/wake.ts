import type { ModelEndpoint } from '../../contracts/config';
import type { WorldEvent } from '@voxel/shared';
import { BackgroundActionTracker } from '../action/background';
import { runFollowStep } from '../action/follow';
import { checkBudgetCap } from '../task/budget';
import { isActiveTask } from '../task/state';
import { restoreCheckpoint } from './checkpoint';
import type { RunOptions } from './options';
import { Turn, type TurnActions } from './turn';

/** What advancing a saved follow intent asks the wake loop to do next. */
type FollowStep = 'idle' | 'resume' | 'stop';

/**
 * One wake-up: follow ticks and background actions first, then event decisions.
 * A queued message always gets its own turn; an unattended turn runs only while
 * the task is active or right after a background action settles.
 */
export class CharacterRunner {
  constructor(
    private endpoint: ModelEndpoint,
    private request: typeof fetch,
  ) {}

  async run(o: RunOptions) {
    const { memory, signal } = o;
    const background = new BackgroundActionTracker();
    let message = o.attention?.take();
    if (!message) restoreCheckpoint(memory);
    await this.parkBudgetExhausted(o);
    let actionResult = false;
    try {
      while (!signal.aborted) {
        switch (await this.advanceFollow(o, message, actionResult)) {
          case 'stop':
            return;
          case 'resume':
            // The failed follow was cleared; run one decision to pick a new step.
            actionResult = true;
            continue;
          case 'idle':
            break;
        }
        if (!message && !actionResult && !isActiveTask(memory.task.current))
          return;
        if (!background.isRunning || message || actionResult) {
          await this.turn(o, message, background);
          actionResult = false;
        }
        message = o.attention?.take();
        if (message) continue;
        if (background.isRunning) {
          await background.wait(o.attention, signal);
          message = o.attention?.take();
          if (!message && background.isSettled) {
            await background.complete();
            actionResult = true;
          }
          continue;
        }
        if (
          message === undefined &&
          memory.task.current?.status === 'running'
        ) {
          actionResult = true;
          continue;
        }
        return;
      }
    } finally {
      await background.cleanup();
    }
  }

  /**
   * Paces a saved follow intent with local navigation instead of a model request.
   * A follow that ended blocked clears itself and asks for one recovery decision.
   */
  private async advanceFollow(
    o: RunOptions,
    message: WorldEvent | undefined,
    actionResult: boolean,
  ): Promise<FollowStep> {
    const { memory } = o;
    if (message || actionResult || !memory.effects.follow) return 'idle';
    if (!isActiveTask(memory.task.current)) return 'idle';
    if (await this.parkBudgetExhausted(o)) return 'stop';
    await runFollowStep(o);
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
  }

  /** Saves a task that cannot afford another request as 'budget'. */
  private async parkBudgetExhausted(o: RunOptions): Promise<boolean> {
    const task = o.memory.task.current;
    if (!isActiveTask(task)) return false;
    const reason = checkBudgetCap(task, o.config);
    if (!reason) return false;
    task.status = 'budget';
    task.reason = reason;
    await o.checkpoint?.();
    return true;
  }

  private turn(
    o: RunOptions,
    message: WorldEvent | undefined,
    background: BackgroundActionTracker,
  ) {
    return new Turn({
      options: o,
      endpoint: this.endpoint,
      request: this.request,
      message,
      actions: this.turnActions(background),
    }).run();
  }

  private turnActions(background: BackgroundActionTracker): TurnActions {
    return {
      running: () => background.isRunning,
      launch: (id, controller, work) => background.launch(id, controller, work),
      stop: () => background.stop(),
    };
  }
}
