import type { TaskPlan } from '@voxel/shared';
import type { StoredRun } from '../domain/types';
import type { PlanService } from './plan-store';
import type { TaskExecutionState } from '../ports';
import { captureTask } from '../services/execution.service';

export type TaskSnapshot = {
  plans: TaskPlan[];
  runs: StoredRun[];
  requests: Record<string, string>;
};

/** Owns task snapshot/restore semantics; the application commits the joint envelope. */
export class TaskSnapshots {
  storageFailed = false;

  captureExecutions(executions: Iterable<TaskExecutionState>) {
    for (const execution of executions) captureTask(execution);
  }

  capture(plans: PlanService): TaskSnapshot {
    return {
      plans: structuredClone(plans.plans),
      runs: structuredClone(plans.runs),
      requests: { ...plans.requests },
    };
  }

  restore(plans: PlanService, snapshot: TaskSnapshot) {
    Object.assign(plans, {
      plans: snapshot.plans,
      runs: snapshot.runs,
      requests: snapshot.requests,
    });
  }

  reject(snapshot: TaskSnapshot, committed: PlanService) {
    const changedPlans = snapshot.plans.filter(
      (p) =>
        JSON.stringify(p) !==
        JSON.stringify(committed.plans.find((old) => old.id === p.id)),
    );
    const changedRuns = snapshot.runs.filter(
      (r) =>
        JSON.stringify(r) !==
        JSON.stringify(committed.runs.find((old) => old.id === r.id)),
    );
    if (changedPlans.length || changedRuns.length) this.storageFailed = true;
    return new Set([...changedPlans, ...changedRuns].map((x) => x.characterId));
  }
}
