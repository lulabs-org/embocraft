import type { AgentRuntime, RuntimeState, Session } from '@voxel/agent-runtime';
import { createAgentRuntime } from '@voxel/agent-runtime';
import type { AICharacterView } from '@voxel/shared';

import type { SavedProvider } from '../../providers';
import type { PlanService } from '../../tasks';

export interface HostedAICharacter {
  run(provider: SavedProvider, run?: boolean): Promise<void>;
}

export type Job = {
  view: AICharacterView;
  host?: HostedAICharacter;
  abort: AbortController;
  session?: Session;
  done?: Promise<void>;
  runtime: AgentRuntime;
  ledger: PlanService;
  currentRunId?: string;
  taskMutating?: boolean;
  updating?: boolean;
  controlling?: boolean;
  storageFailed?: boolean;
};

export const active = (status: AICharacterView['status']) =>
  ['joining', 'running', 'stopping'].includes(status);

export const resident = (job: Job) => !!job.session || active(job.view.status);

/** 判定角色当前是否处于阻塞性变更状态（更新、控制、任务变更） */
export const isJobBusy = (job: Job) =>
  !!(job.updating || job.controlling || job.taskMutating);

/** 判定角色是否具备被唤醒执行动作的就绪条件 */
export const canWakeJob = (job: Job, closing: boolean) =>
  !closing &&
  !job.storageFailed &&
  !isJobBusy(job) &&
  (job.view.status === 'idle' ||
    (job.view.status === 'failed' && job.runtime.pendingMessages)) &&
  !!job.session;

/** The sole owner of hosted Agent instances. Never shared with standalone CLI instances. */
export class AICharacterRegistry extends Map<string, Job> {}

/** The runtime owns state and attention for the whole lifetime of a hosted character. */
export function createCharacterJob(
  input: Omit<Job, 'runtime'>,
  state?: RuntimeState,
): Job {
  const runtime = createAgentRuntime({ state });
  return {
    ...input,
    runtime,
  };
}
