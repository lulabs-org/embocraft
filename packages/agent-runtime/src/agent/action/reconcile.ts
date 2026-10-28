import { key } from '@voxel/shared';
import type {
  ActionExecution,
  BatchResult,
  PlannedEdit,
} from '../../contracts/action';
import type { Observation } from '../../contracts/observation';
import type { RuntimeState } from '../../contracts/state';
import { arrived, observedEmpty } from '../../world/observe/verify';
import { restoreBatchHistory } from '../task/state';

/**
 * Repairs world-write bookkeeping against a fresh observation before the model
 * decides again. Both reconcilers mutate `memory.effects` in place and are
 * idempotent: an effect proven by the observation is dropped, everything else
 * stays pending and is shown to the model on the next turn.
 */

/** Drops blueprint blocks that the observation proves are already in place. */
export function reconcileUnfinishedBuild(
  memory: RuntimeState,
  observation: Observation,
) {
  const build = memory.execution.effects.unfinishedBuild;
  if (!build) return;
  const observed = observedMaterials(observation);
  const remaining = build.result.remaining.filter((block) =>
    block.material === null
      ? !observedEmpty(observation, block)
      : observed.get(key(block)) !== block.material,
  );
  if (!remaining.length) {
    memory.execution.effects.unfinishedBuild = undefined;
    return;
  }
  build.result.remaining = remaining;
  build.result.uncertain = build.result.uncertain?.filter((block) =>
    remaining.some((other) => key(other) === key(block)),
  );
}

/** Observed materials by block key; the observation is host-supplied, so tolerate gaps. */
function observedMaterials(observation: Observation) {
  return new Map(
    (observation.blocks ?? []).map((block) => [key(block), block.material]),
  );
}

/** Drops a pending batch once every unacknowledged effect is observable. */
export function reconcilePendingEffects(
  memory: RuntimeState,
  observation: Observation,
) {
  const pending = memory.execution.effects.pendingEffects;
  if (!pending) return;
  const correctedArrival = replacementArrived(
    observation,
    memory.execution.effects.previous as BatchResult | undefined,
  );
  const resolved = pending.results
    .filter((execution) => !['pending', 'succeeded'].includes(execution.status))
    .every((execution) =>
      effectResolved(memory, observation, execution, correctedArrival),
    );
  if (!resolved) return;
  clearReconciledUnknownEffect(memory, pending);
  delete memory.execution.effects.pendingEffects;
}

/** Whether one unacknowledged execution can be seen in the current world. */
function effectResolved(
  memory: RuntimeState,
  observation: Observation,
  execution: ActionExecution,
  correctedArrival: boolean,
): boolean {
  const { action } = execution;
  switch (action.type) {
    case 'edit':
      return editVisible(observation, action);
    case 'goto':
      return (
        arrived(observation, action) ||
        (failedNavigation(execution) && correctedArrival)
      );
    case 'follow':
      return (
        !!memory.execution.effects.follow &&
        memory.execution.effects.follow.taskStartedAt ===
          memory.execution.task.current?.startedAt
      );
    case 'move':
      return movedSince(observation, execution.before);
    case 'build':
    case 'house':
      return !memory.execution.effects.unfinishedBuild;
    default:
      return false;
  }
}

/** An edit is confirmed by its material being present, or proven absence for removals. */
function editVisible(observation: Observation, edit: PlannedEdit): boolean {
  if (edit.material === null) return observedEmpty(observation, edit);
  return observation.blocks.some(
    (block) => key(block) === key(edit) && block.material === edit.material,
  );
}

/** A failed navigation only reconciles behind a later verified arrival. */
function failedNavigation(execution: ActionExecution): boolean {
  const { result } = execution;
  return (
    execution.status === 'failed' &&
    !!result &&
    'status' in result &&
    result.status === 'failed'
  );
}

/** A movement is confirmed by any displacement from its recorded start position. */
function movedSince(
  observation: Observation,
  before: ActionExecution['before'],
): boolean {
  return (
    !!before &&
    Math.hypot(
      observation.self.x - before.x,
      observation.self.y - before.y,
      observation.self.z - before.z,
    ) >= 0.05
  );
}

/** A verified replacement destination supersedes a known navigation failure. */
function replacementArrived(
  observation: Observation,
  latest: BatchResult | undefined,
): boolean {
  return !!latest?.results?.some((execution) => {
    const { action } = execution;
    if (action.type !== 'goto' || execution.status !== 'succeeded')
      return false;
    const { result } = execution;
    return (
      !!result &&
      result.ok &&
      'status' in result &&
      result.status === 'arrived' &&
      arrived(observation, action)
    );
  });
}

/** Forgets an unknown effect once its own batch has finished reconciling. */
function clearReconciledUnknownEffect(
  memory: RuntimeState,
  pending: BatchResult,
) {
  const unknown = memory.execution.checkpoint.unknownEffect;
  if (!unknown || unknown.name === 'chat') return;
  const ownsUnknownEffect = pending.results.some(
    (execution) => execution.action.type === unknown.name,
  );
  if (!ownsUnknownEffect) return;
  delete memory.execution.checkpoint.unknownEffect;
  if (memory.execution.checkpoint.pi?.inFlight?.id === unknown.id)
    delete memory.execution.checkpoint.pi.inFlight;
}

/** Reconcile observed progress before exposing action state to a decision. */
export function reconcileActionEffects(
  memory: RuntimeState,
  observation: Observation,
) {
  reconcileUnfinishedBuild(memory, observation);
  reconcilePendingEffects(memory, observation);
}

/** Project prompt fields while hiding action-specific state from the turn. */
export function actionDecisionContext(memory: RuntimeState, visible: boolean) {
  return {
    previous: visible ? memory.execution.effects.previous : undefined,
    pendingEffects: visible
      ? memory.execution.effects.pendingEffects
      : undefined,
    follow: visible ? memory.execution.effects.follow : undefined,
    unfinishedBuild: visible
      ? memory.execution.effects.unfinishedBuild
      : undefined,
  };
}

/** Picks up an interrupted effect ledger; unknown results stay pending for reconciliation. */
export function restoreActionEffects(memory: RuntimeState) {
  const previous = restoreBatchHistory(memory.execution.effects.previous);
  memory.execution.effects.previous = previous;
  if (memory.execution.effects.pendingEffects)
    memory.execution.effects.pendingEffects = restoreBatchHistory(
      memory.execution.effects.pendingEffects,
    );
  if (
    !memory.execution.effects.pendingEffects &&
    previous?.results?.some((result) => result.status === 'unknown')
  )
    memory.execution.effects.pendingEffects = structuredClone(previous);
}
