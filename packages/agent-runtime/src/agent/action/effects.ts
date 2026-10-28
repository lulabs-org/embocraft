import type { AgentAction } from '../../contracts/action';
import type { Observation } from '../../contracts/observation';
import type { AgentRunState } from '../../contracts/state';
import type { ToolState } from '../../contracts/tool-state';
import type { BatchOptions } from '../../world/actions/batch';
import type { TaskLease, TaskService } from '../task/service';
import { createBuildEffects } from './build-tracker';
import {
  activateFollowing,
  createFollowEffects,
  settleFollowing,
} from './follow';

/** Execution policies preserve existing timing and replay rules for every action. */
export function actionPolicy(name: AgentAction['type']) {
  return {
    background: name === 'goto' || name === 'build' || name === 'house',
    mutating: ['goto', 'follow', 'edit', 'build', 'house'].includes(name),
    blocksUnknownReplay:
      name === 'chat' || name === 'goto' || name === 'follow',
  };
}

/** Concrete progress hooks live here, never in the turn or generic task executor. */
export function createActionEffects(
  memory: AgentRunState,
  save: () => Promise<void>,
) {
  const build = createBuildEffects(memory);
  const follow = createFollowEffects(memory);
  const hooks = {
    navigation: { follow: follow.control },
    beforeAction: async (action) => {
      if (follow.before(action)) await save();
      if (build.before(action)) await save();
    },
    buildCheckpoint: build.progress,
    checkpoint: build.checkpoint,
  } satisfies BatchOptions;
  return { ...hooks, complete: follow.complete };
}

export function settleActionEffects(
  name: AgentAction['type'],
  memory: AgentRunState,
  service: TaskService,
  lease: TaskLease,
  observation: Observation,
  state: ToolState,
) {
  if (name === 'follow')
    settleFollowing(memory, service, lease, observation, state);
}

export function activateContinuingAction(
  name: AgentAction['type'],
  memory: AgentRunState,
  id: string,
  lease: TaskLease,
) {
  if (name === 'follow') activateFollowing(memory, id, lease);
}
