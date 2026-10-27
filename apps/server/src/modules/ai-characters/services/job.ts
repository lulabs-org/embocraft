import type { AICharacterView } from '@voxel/shared';
import type {
  AgentAttention,
  AgentRunState,
  Session,
} from '@voxel/agent-runtime';
import type { PlanService } from '../../tasks';
import type { SavedProvider } from '../../providers';

export interface HostedAICharacter {
  run(provider: SavedProvider, run?: boolean): Promise<void>;
}

export type Job = {
  view: AICharacterView;
  host?: HostedAICharacter;
  abort: AbortController;
  session?: Session;
  done?: Promise<void>;
  memory: AgentRunState;
  ledger: PlanService;
  currentRunId?: string;
  taskMutating?: boolean;
  attention: AgentAttention;
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
    (job.view.status === 'failed' && job.attention.pending)) &&
  !!job.session;

/** The sole owner of hosted Agent instances. Never shared with standalone CLI instances. */
export class AICharacterRegistry extends Map<string, Job> {}
