import type { TaskExecutionState } from '../../tasks';
import type { Job } from './job';

const states = new WeakMap<Job, TaskExecutionState>();

/**
 * 将角色的内部 Job 状态适配为 Tasks 模块所需的 TaskExecutionState，
 * 隐藏底层的网络会话与 Runner，仅暴露任务状态及必要的变更守卫。
 */
export function taskExecutionState(job: Job): TaskExecutionState {
  const previous = states.get(job);
  if (previous) return previous;
  const state: TaskExecutionState = {
    get runtime() {
      return job.runtime;
    },
    get view() {
      return job.view;
    },
    set view(value: TaskExecutionState['view']) {
      job.view = {
        createdAt: job.view.createdAt,
        providerName: job.view.providerName,
        ...value,
      };
    },
    get ledger() {
      return job.ledger;
    },
    get currentRunId() {
      return job.currentRunId;
    },
    set currentRunId(value) {
      job.currentRunId = value;
    },
    get taskMutating() {
      return job.taskMutating;
    },
    set taskMutating(value) {
      job.taskMutating = value;
    },
    get updating() {
      return job.updating;
    },
    get controlling() {
      return job.controlling;
    },
    get storageFailed() {
      return job.storageFailed;
    },
    get online() {
      return !!job.session;
    },
  };
  states.set(job, state);
  return state;
}

export { taskExecutionState as executionState };
