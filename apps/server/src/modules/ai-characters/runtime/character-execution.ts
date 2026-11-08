import { AppError } from '../../../core/errors/app-error';
import type { ProviderRuntimePort, SavedProvider } from '../../providers';
import { markOffline } from '../../tasks';
import { appendAICharacterLog } from '../domain/activity-log';
import { executionState } from '../integrations/task-execution-adapter';
import type { CharacterVoiceCoordinator } from '../integrations/voice-coordinator';
import { AICharacterHost } from './character-host';
import {
  canWakeJob,
  isJobBusy,
  resident,
  type AICharacterRegistry,
  type Job,
} from './character-registry';
import type { ExecutionContext } from './execution-context';
import type { AICharacterWakeScheduler } from './wake-scheduler';

type RuntimeContext = {
  jobs: AICharacterRegistry;
  scheduler: AICharacterWakeScheduler;
  providers: ProviderRuntimePort;
  serverUrl: string | (() => string);
  dependencies: ExecutionContext['dependencies'];
  voice: CharacterVoiceCoordinator;
  closing: () => boolean;
  controlMessage: ExecutionContext['controlMessage'];
  save: () => Promise<void>;
  persist: () => Promise<void>;
};

/** Prevent further execution of characters whose changes could not be saved. */
export function protectCharactersAfterStorageFailure(
  jobs: AICharacterRegistry,
  scheduler: Pick<AICharacterWakeScheduler, 'cancel'>,
  ids: Iterable<string>,
) {
  for (const id of ids) {
    const job = jobs.get(id);
    if (!job) continue;
    job.storageFailed = true;
    job.abort.abort();
    scheduler.cancel(id);
  }
}

/** Owns execution, wake-up, and stopping of hosted characters. */
export class CharacterExecutionService {
  constructor(private readonly context: RuntimeContext) {}

  taskJob(id: string) {
    const job = this.context.jobs.get(id);
    if (!job) throw new AppError('Agent 不存在。', 404);
    if (this.context.closing()) throw new AppError('世界服务正在关闭。', 503);
    return job;
  }

  launchReserved(job: Job) {
    this.context.scheduler.cancel(job.view.id);
    job.view.status = 'running';
    job.abort = new AbortController();
    job.done = this.execute(job);
  }

  wake(job: Job) {
    if (!canWakeJob(job, this.context.closing())) return;
    this.context.scheduler.cancel(job.view.id);
    job.view.status = 'running';
    job.abort = new AbortController();
    job.done = this.execute(job);
  }

  schedule(job: Job) {
    this.context.scheduler.cancel(job.view.id);
    if (!canWakeJob(job, this.context.closing())) return;
    const delay = job.runtime.nextWakeDelay({ ...job.view, apiKey: '' });
    if (delay !== undefined)
      this.context.scheduler.wake(job.view.id, delay, () => this.wake(job));
  }

  /** Host primitive only: stop the runner, then let Tasks commit the chosen transition. */
  async withStoppedExecution<T>(
    id: string,
    change: () => Promise<T>,
  ): Promise<T> {
    const job = this.taskJob(id);
    if (isJobBusy(job) || ['joining', 'stopping'].includes(job.view.status))
      throw new AppError('Agent 状态正在更新，请稍候。', 409);
    job.controlling = true;
    this.context.scheduler.cancel(id);
    job.runtime.clearMessages();
    job.abort.abort();
    try {
      await job.done;
      if (job.session) job.view.status = 'idle';
      return await change();
    } finally {
      job.controlling = false;
      this.schedule(job);
    }
  }

  async execute(job: Job, provider?: SavedProvider, run = true) {
    if (job.storageFailed) {
      job.view.status = 'failed';
      return;
    }
    if (!provider) {
      try {
        provider = await this.context.providers.getRuntime(job.view.providerId);
      } catch (error) {
        if (!job.abort.signal.aborted && !this.context.closing()) {
          job.view.status = 'failed';
          appendAICharacterLog(
            job.view,
            error instanceof AppError
              ? error.message
              : '无法读取模型服务配置。',
          );
          void this.context.persist();
        }
        return;
      }
      if (job.abort.signal.aborted || this.context.closing()) return;
    }
    const ctx: ExecutionContext = {
      serverUrl:
        typeof this.context.serverUrl === 'string'
          ? this.context.serverUrl
          : this.context.serverUrl(),
      dependencies: this.context.dependencies,
      unbindVoice: (sessionId) => this.context.voice.unbindVoice(sessionId),
      closing: () => this.context.closing(),
      bindVoice: (j) => this.context.voice.bindVoice(j),
      controlMessage: (targetId, op, identity, commandId, message) =>
        this.context.controlMessage(targetId, op, identity, commandId, message),
      wake: (j) => this.wake(j),
      schedule: (j) => this.schedule(j),
      save: () => this.context.save(),
      persist: () => {
        void this.context.persist();
      },
    };
    job.host ??= new AICharacterHost(job, ctx);
    return job.host.run(provider, run);
  }

  protectAfterStorageFailure(ids: Iterable<string>) {
    protectCharactersAfterStorageFailure(
      this.context.jobs,
      this.context.scheduler,
      ids,
    );
  }

  stop(id: string) {
    const job = this.context.jobs.get(id);
    if (!job) throw new AppError('Agent 不存在。', 404);
    if (
      job.view.status !== 'stopping' &&
      (resident(job) || job.view.status !== 'stopped')
    ) {
      this.context.scheduler.cancel(job.view.id);
      job.view.status = 'stopping';
      job.runtime.clearMessages();
      job.abort.abort();
      const closed = job.session
        ?.close()
        .catch(() => job.session?.room?.connection.close());
      const previous = job.done;
      job.done = (async () => {
        await Promise.allSettled([previous, closed]);
        await job.session
          ?.close()
          .catch(() => job.session?.room?.connection.close());
        job.session = undefined;
        delete job.view.sessionId;
        job.view.status = 'stopped';
        markOffline(executionState(job));
        void this.context.persist();
      })();
    }
  }
}
