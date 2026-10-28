import {
  createAgentRuntime,
  runtimeView,
  type AgentRunState,
} from '@voxel/agent-runtime';
import { isRepeating } from '@voxel/shared';
import { duePlans, endedRun, newRun, nextOccurrence } from '../domain/model';
import { captureTask } from '../services/execution.service';
import type { TaskExecutionState } from '../ports';

export function restoreTaskMemory(
  runtime: AgentRunState | undefined,
): AgentRunState {
  const agent = createAgentRuntime();
  agent.restore(runtime);
  return agent.snapshot();
}

/** Restore task policy without starting a host, replaying unknown actions or dispatching missed triggers. */
export function restoreTaskExecution(job: TaskExecutionState) {
  job.runtime.recoverAfterRestart();
  const interruptedRuns = new Set(
    job.ledger.runs
      .filter((r) => r.characterId === job.view.id)
      .filter((r) =>
        [
          'running',
          'waiting',
          'failed',
          'budget',
          'blocked',
          'needs_input',
        ].includes(r.status),
      )
      .map((r) => r.id),
  );
  captureTask(job);

  for (const run of job.ledger.runs.filter(
    (r) => r.characterId === job.view.id,
  )) {
    if (run.runtime) {
      const runtime = createAgentRuntime();
      runtime.restore(run.runtime);
      const recovery = runtime.recoverHistory({
        unfinished: !endedRun(run),
        running: ['running', 'waiting'].includes(run.status),
      });
      if (recovery.audienceExpired) {
        run.status = 'needs_input';
        run.task = runtime.view().task;
      }
      if (['running', 'waiting'].includes(run.status)) {
        run.task = runtime.view().task ?? run.task;
      }
      run.runtime = runtime.snapshot();
    }
    for (const action of run.actions ?? [])
      if (action.status === 'executing') action.status = 'unknown';
    if (['running', 'waiting'].includes(run.status)) {
      run.status = 'paused';
      run.reason = '服务重启，进度保留，请手动继续。';
    }
    if (
      !endedRun(run) &&
      (interruptedRuns.has(run.id) ||
        (run.runtime && runtimeView(run.runtime).requiresReassignment))
    ) {
      const p = job.ledger.plans.find((p) => p.id === run.planId);
      if (p) {
        p.state = 'paused';
        p.reason = '执行尚未结束，请确认后恢复计划。';
        delete p.nextRunAt;
      }
    }
  }

  for (const plan of duePlans(job.ledger, Date.now()).filter(
    (p) => p.characterId === job.view.id,
  )) {
    const run = newRun(
      { ...plan, characterName: job.view.name },
      plan.nextRunAt!,
      'scheduled',
    );
    run.status = isRepeating(plan.timing) ? 'skipped' : 'missed';
    run.reason = '服务未运行，错过的触发不补跑。';
    run.finishedAt = Date.now();
    job.ledger.runs.push(run);
    plan.nextRunAt = nextOccurrence(plan, Date.now());
    if (!isRepeating(plan.timing)) plan.state = 'completed';
  }
}
