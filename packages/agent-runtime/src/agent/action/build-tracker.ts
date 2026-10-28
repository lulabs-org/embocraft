import { key } from '@voxel/shared';
import type {
  AgentAction,
  BatchResult,
  BuildAction,
  BuildResult,
  Observation,
  PlannedEdit,
} from '../../contracts';
import type { EffectsSection, RuntimeState } from '../../contracts/state';
import { houseBlocks } from '../../world/actions/build';
import { observedEmpty } from '../../world/observe/verify';

export type UnfinishedBuild = EffectsSection['unfinishedBuild'];

function actionBlocks(action: BuildAction): PlannedEdit[] {
  return action.type === 'house' ? houseBlocks(action) : action.blocks;
}

function extraRemainingBlocks(
  priorBuild: UnfinishedBuild,
  blocks: PlannedEdit[],
): PlannedEdit[] {
  return (
    priorBuild?.result.remaining.filter(
      (b) => !blocks.some((p) => key(p) === key(b)),
    ) ?? []
  );
}

/** Initializes unfinished build state before a `build` or `house` action starts. */
export function beginUnfinishedBuild(
  priorBuild: UnfinishedBuild,
  action: BuildAction,
): NonNullable<UnfinishedBuild> {
  const blocks = actionBlocks(action);
  const extra = extraRemainingBlocks(priorBuild, blocks);
  return {
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
}

/** Merges incremental `executeBuild` checkpoint progress with any prior unfinished blocks. */
export function mergeBuildCheckpoint(
  priorBuild: UnfinishedBuild,
  action: BuildAction,
  result: BuildResult,
): UnfinishedBuild {
  const blocks = actionBlocks(action);
  const extra = extraRemainingBlocks(priorBuild, blocks);
  const merged: BuildResult = {
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
  return merged.ok ? undefined : { action, result: merged };
}

/** Removes blocks from `unfinishedBuild` that were completed by individual `edit` actions in a batch. */
export function reconcileUnfinishedBuild(
  unfinishedBuild: UnfinishedBuild,
  batch: BatchResult,
): UnfinishedBuild {
  if (!unfinishedBuild) return undefined;
  unfinishedBuild.result.remaining = unfinishedBuild.result.remaining.filter(
    (b) =>
      !batch.results.some(
        (r) =>
          r.status === 'succeeded' &&
          r.action.type === 'edit' &&
          key(r.action) === key(b) &&
          r.action.material === b.material,
      ),
  );
  return unfinishedBuild.result.remaining.length ? unfinishedBuild : undefined;
}

/** Formats action execution output and verifies requested block edits against the latest observation. */
export function formatActionResult(
  action: AgentAction,
  batch: BatchResult,
  observation: Observation,
  memory: RuntimeState,
) {
  const edits =
    action.type === 'edit'
      ? [action]
      : action.type === 'build'
        ? action.blocks
        : action.type === 'house'
          ? houseBlocks(action)
          : [];
  const unconfirmed = edits.filter((edit) =>
    edit.material === null
      ? !observedEmpty(observation, edit)
      : !observation.blocks.some(
          (b) =>
            b.x === edit.x &&
            b.y === edit.y &&
            b.z === edit.z &&
            b.material === edit.material,
        ),
  );
  return {
    batch,
    ...(edits.length
      ? {
          verification: {
            requested: edits.length,
            observedMatching: edits.length - unconfirmed.length,
            unconfirmed,
          },
        }
      : {}),
    position: observation.self,
    revision: observation.revision,
    unfinishedBuild: memory.execution.effects.unfinishedBuild,
  };
}

/** One batch captures its prior blueprint once, including blocks outside a replacement. */
export function createBuildEffects(memory: RuntimeState) {
  const prior = memory.execution.effects.unfinishedBuild;
  return {
    before(action: AgentAction): boolean {
      if (action.type !== 'build' && action.type !== 'house') return false;
      memory.execution.effects.unfinishedBuild = beginUnfinishedBuild(
        prior,
        action,
      );
      return true;
    },
    progress(action: BuildAction, result: BuildResult) {
      memory.execution.effects.unfinishedBuild = mergeBuildCheckpoint(
        prior,
        action,
        result,
      );
    },
    checkpoint(batch: BatchResult) {
      memory.execution.effects.unfinishedBuild = reconcileUnfinishedBuild(
        memory.execution.effects.unfinishedBuild,
        batch,
      );
    },
  };
}
