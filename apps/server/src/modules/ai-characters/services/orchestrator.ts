import { ManagementEvents } from '../../management';
import { ManagementPersistence } from '../../../persistence/management-persistence';
import { migrateArchive } from '../../../persistence/migrate-archive';
import type { ArchivePort } from '../../../persistence/archive';
import { AICharacterWakeScheduler } from '../runtime/wake-scheduler';
import { appendAICharacterLog } from '../domain/activity-log';
import {
  aiCharacterPermissions,
  type AICharacterSettings,
} from '@voxel/shared';
import { randomUUID } from 'node:crypto';
import { emptyState } from '@voxel/agent-runtime';
import type { ProviderRuntimePort, SavedProvider } from '../../providers';
import {
  AgentAttention,
  nextIntervalMs,
  type Session,
  type AgentRunner,
  type AgentConfig,
} from '@voxel/agent-runtime';

import { object, text, boolean } from '../../../core/http/validation';
import {
  validateAICharacter,
  aiCharacterProfileInput,
} from '../domain/validation';
import { AppError } from '../../../core/errors/app-error';

import {
  active,
  resident,
  isJobBusy,
  canWakeJob,
  type Job,
  AICharacterRegistry,
} from '../runtime/job';
import type { VoiceServicePort } from '../ports';
import {
  pauseTaskForHost,
  markJoined,
  markOffline,
  modelChanged,
  TaskCoordinator,
  TaskSnapshots,
} from '../../tasks';
import { executionState } from '../runtime/task-adapter';
import { restoreAICharacterJob } from '../persistence/restore';
import { AICharacterHost } from '../runtime/character-host';
import type { ExecutionContext } from '../runtime/execution-context';
import { CharacterSnapshots } from '../persistence/snapshots';
import { CharacterVoiceCoordinator } from './voice-coordinator';

export class AICharacterOrchestrator {
  readonly jobs = new AICharacterRegistry();
  readonly events = new ManagementEvents();
  readonly taskScheduler = new AICharacterWakeScheduler();
  readonly persistence: ManagementPersistence<
    CharacterSnapshots,
    TaskSnapshots
  >;
  readonly tasks: TaskCoordinator;
  readonly voiceCoordinator: CharacterVoiceCoordinator;

  private closing = false;
  private restoreFailed = false;
  private closePromise?: Promise<void>;
  private shutdownPresence = new Map<string, Job['view']['status']>();

  constructor(
    private readonly providers: ProviderRuntimePort,
    private serverUrl: string | (() => string),
    private dependencies: AICharacterDependencies,
    readonly voiceServices: VoiceServicePort | undefined,
    private archive: ArchivePort,
  ) {
    const characters = new CharacterSnapshots();
    const tasks = new TaskSnapshots();
    this.persistence = new ManagementPersistence(
      this.archive,
      (snapshot) => this.events.commit(snapshot.characters, snapshot),
      {
        characters,
        tasks,
        captureExecutions: () =>
          tasks.captureExecutions([...this.jobs.values()].map(executionState)),
        captureCharacters: () =>
          characters.capture(
            this.jobs,
            () => this.list(),
            this.shutdownPresence,
          ),
        captureTasks: () => tasks.capture(this.plans),
        rejectTasks: (snapshot) => tasks.reject(snapshot, this.committedPlans),
        rejectCharacters: (records, affected) =>
          characters.reject(records, this.jobs, affected, (id) =>
            this.taskScheduler.cancel(id),
          ),
        commitCharacters: (records, views) => characters.commit(records, views),
        restoreTasks: (snapshot) =>
          tasks.restore(this.committedPlans, snapshot),
      },
    );
    this.voiceCoordinator = new CharacterVoiceCoordinator(this.voiceServices);
    this.tasks = new TaskCoordinator({
      execution: (id) => executionState(this.taskJob(id)),
      findExecution: (id) => {
        const job = this.jobs.get(id);
        return job ? executionState(job) : undefined;
      },
      executions: () => [...this.jobs.values()].map(executionState),
      save: () => this.save(),
      schedule: (id) => {
        const job = this.jobs.get(id);
        if (job) this.schedule(job);
      },
      launch: (id) => this.launchReserved(this.taskJob(id)),
      withStoppedExecution: (id, change) =>
        this.withStoppedExecution(id, change),
      validateExecution: (id, overrides) => {
        const job = this.taskJob(id);
        const settings = validateAICharacter(
          { ...job.view, ...overrides },
          this.providers.getRuntime(job.view.providerId),
        );
        this.checkVoice(settings);
        return settings;
      },
      storageFailed: () => this.persistence.tasks.storageFailed,
      committedName: (id) =>
        this.persistence.characters.committedCharacterName(id),
      publicIdentity: (id) => this.persistence.characters.publicIdentity(id),
      resourceVersion: () => this.events.version,
      isClosing: () => this.closing,
      assertWritable: (id) => this.assertWritable(id),
    });
  }

  get storageRevision() {
    return this.persistence.storageRevision;
  }

  get plans() {
    return this.tasks.plans;
  }

  get committedPlans() {
    return this.tasks.committedPlans;
  }

  get planScheduler() {
    return this.tasks.planScheduler;
  }

  assertWritable(id?: string) {
    if (this.restoreFailed)
      throw new AppError('AI 角色存档恢复失败，请修复存档后重启服务。', 503);
    this.persistence.assertWritable(
      this.closing,
      id ? this.jobs.get(id)?.storageFailed : undefined,
    );
  }

  publicList() {
    return this.persistence.characters.publicList();
  }

  publicIdentity(id: string) {
    return this.persistence.characters.publicIdentity(id);
  }

  publicLogEntries(id: string) {
    return this.persistence.characters.publicLogEntries(id);
  }

  async settled(id: string) {
    await this.jobs.get(id)?.done;
  }

  private persist() {
    // Shutdown also runs after failed startup; never replace unread/partially restored data.
    if (this.restoreFailed) return Promise.resolve();
    return this.persistence.persist();
  }

  private save(): Promise<void> {
    return this.persist();
  }

  async flush(since = this.storageRevision) {
    return this.persistence.flush(since);
  }

  async load() {
    try {
      await this.restoreArchive();
    } catch (error) {
      this.restoreFailed = true;
      throw error;
    }
  }

  private async restoreArchive() {
    const raw = await this.archive.load();
    const saved = raw ? migrateArchive(raw) : undefined;
    if (!saved) {
      this.planScheduler.start();
      return;
    }
    this.persistence.tasks.restore(this.plans, saved);
    const autoJoin: Job[] = [];
    for (const view of saved.characters) {
      const { job, voiceWarning, shouldAutoJoin } = restoreAICharacterJob(
        view,
        this.providers,
        (settings) => this.checkVoice(settings),
        this.plans,
      );
      this.jobs.set(view.id, job);
      if (voiceWarning) appendAICharacterLog(job.view, voiceWarning);
      if (shouldAutoJoin) autoJoin.push(job);
    }
    await this.save();
    for (const job of autoJoin.slice(0, 4)) {
      job.view.status = 'joining';
      job.done = this.execute(
        job,
        this.providers.getRuntime(job.view.providerId),
        false,
      );
      await job.done;
    }
    this.planScheduler.start();
  }

  currentRunId(id: string) {
    return this.jobs.get(id)?.currentRunId;
  }

  taskIdentity(id: string) {
    return this.jobs.get(id)?.memory.task.identity;
  }

  interrupt(id: string) {
    this.jobs.get(id)?.abort.abort();
  }

  private checkVoice(settings: AICharacterSettings) {
    this.voiceCoordinator.checkVoice(settings);
  }

  private bindVoice(job: Job) {
    this.voiceCoordinator.bindVoice(job);
  }

  list() {
    return [...this.jobs.values()]
      .map(({ view, memory, currentRunId }) => {
        const run = this.plans.runs.find((run) => run.id === currentRunId);
        return structuredClone({
          ...view,
          goal: memory.task.current?.goal ?? view.goal,
          voiceServiceName: this.voiceCoordinator.getServiceName(
            view.voiceServiceId,
          ),
          task: memory.task.current,
          taskExecution: run
            ? {
                runId: run.id,
                limits: run.snapshot.limits,
                source: run.source,
                action: memory.effects.activeAction
                  ? {
                      id: memory.effects.activeAction.id,
                      name: memory.effects.activeAction.name,
                      status: memory.effects.activeAction.status,
                    }
                  : undefined,
              }
            : undefined,
          queuedTasks: this.plans.runs
            .filter((r) => r.characterId === view.id && r.status === 'queued')
            .sort((a, b) => a.scheduledAt - b.scheduledAt)
            .map((r) => ({
              id: r.id,
              goal: r.snapshot.goal,
              scheduledAt: r.scheduledAt,
              coalescedTriggers: r.coalescedTriggers ?? 0,
            })),
          usage: memory.task.usage,
          lastResponse: memory.health.lastResponse,
          taskRequiresReassignment: !!memory.conversation.audienceExpired,
        });
      })
      .reverse();
  }

  private taskJob(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new AppError('Agent 不存在。', 404);
    if (this.closing) throw new AppError('世界服务正在关闭。', 503);
    return job;
  }

  private launchReserved(job: Job) {
    this.taskScheduler.cancel(job.view.id);
    job.view.status = 'running';
    job.abort = new AbortController();
    job.done = this.execute(
      job,
      this.providers.getRuntime(job.view.providerId),
    );
  }

  create(value: unknown) {
    if (this.closing) throw new AppError('世界服务正在关闭。', 503);
    const input = aiCharacterProfileInput(value);
    const provider = this.providers.getRuntime(
      text(input.providerId, '模型服务', 80),
    );
    const settings = validateAICharacter({ ...input, goal: '' }, provider);
    const joinWorld = boolean(input.joinWorld, true);
    this.checkVoice(settings);
    if (joinWorld && [...this.jobs.values()].filter(resident).length >= 4)
      throw new AppError(
        '最多同时在线 4 个受管理的 Agent（含待命），请先关闭一个。',
        409,
      );
    if (this.jobs.size >= 50)
      throw new AppError(
        '最多保存 50 个 Agent；为保留任务历史，不能自动删除旧角色。',
        409,
      );
    const job: Job = {
      view: {
        ...settings,
        id: randomUUID(),
        providerName: provider.name,
        status: joinWorld ? 'joining' : 'stopped',
        createdAt: Date.now(),
        logEntries: [],
      },
      abort: new AbortController(),
      memory: emptyState(),
      ledger: this.plans,
      attention: new AgentAttention(),
    };
    this.jobs.set(job.view.id, job);
    if (joinWorld) job.done = this.execute(job, provider, false);
    void this.persist();
    return this.list().find((v) => v.id === job.view.id)!;
  }

  join(id: string) {
    if (this.closing) throw new AppError('世界服务正在关闭。', 503);
    const job = this.jobs.get(id);
    if (!job) throw new AppError('Agent 不存在。', 404);
    if (resident(job) || isJobBusy(job))
      throw new AppError('角色已在线或正在更新，请稍候。', 409);
    if ([...this.jobs.values()].filter(resident).length >= 4)
      throw new AppError(
        '最多同时在线 4 个 Agent，请先让一个角色离开世界。',
        409,
      );
    const provider = this.providers.getRuntime(job.view.providerId);
    const settings = validateAICharacter(job.view, provider);
    this.checkVoice(settings);
    this.taskScheduler.cancel(job.view.id);
    markJoined(executionState(job));
    Object.assign(job.view, settings, {
      providerName: provider.name,
      status: 'joining',
    });
    job.attention.clear();
    job.abort = new AbortController();
    job.done = this.execute(job, provider, false);
    void this.persist();
    return this.list().find((v) => v.id === id)!;
  }

  async update(id: string, value: unknown) {
    if (this.closing) throw new AppError('世界服务正在关闭。', 503);
    const job = this.jobs.get(id);
    if (!job) throw new AppError('Agent 不存在。', 404);
    const input = aiCharacterProfileInput(value);
    if (active(job.view.status) || isJobBusy(job))
      throw new AppError('请等待 Agent 待命，或关闭后再修改参数。', 409);
    const provider = this.providers.getRuntime(
      text(input.providerId, '模型服务', 80, job.view.providerId),
    );
    const currentGoal = job.memory.task.current?.goal ?? job.view.goal;
    const settings = validateAICharacter(
      {
        ...job.view,
        ...input,
        goal: currentGoal,
        permissions:
          input.permissions !== undefined
            ? input.permissions
            : input.allowEdits !== undefined
              ? undefined
              : job.view.permissions,
      },
      provider,
    );
    this.checkVoice(settings);
    job.updating = true;
    try {
      const session = job.session;
      if (
        session &&
        (!!settings.voiceReplies && aiCharacterPermissions(settings).chat) !==
          (!!job.view.voiceReplies && aiCharacterPermissions(job.view).chat)
      ) {
        const result = await this.voiceCoordinator.syncSessionVoice(
          session,
          !!settings.voiceReplies && aiCharacterPermissions(settings).chat,
        );
        if (!result.ok || job.session !== session || active(job.view.status))
          throw new AppError('语音开关未保存，请刷新后重试。', 409);
      }
      if (session && settings.name !== job.view.name) {
        const result = await session.request('rename', { name: settings.name });
        if (!result.ok || job.session !== session || active(job.view.status))
          throw new AppError('角色状态已变化，未保存参数，请刷新后重试。', 409);
      }
      if (
        settings.providerId !== job.view.providerId ||
        settings.model !== job.view.model
      ) {
        this.taskScheduler.cancel(job.view.id);
        modelChanged(executionState(job));
        job.attention.clear();
      } else if (
        JSON.stringify(aiCharacterPermissions(settings)) !==
          JSON.stringify(aiCharacterPermissions(job.view)) ||
        JSON.stringify(settings.skills) !== JSON.stringify(job.view.skills)
      ) {
        this.taskScheduler.cancel(job.view.id);
        job.attention.clear();
        pauseTaskForHost(
          executionState(job),
          '角色技能或动作权限已修改，进度已保留，请确认后继续。',
        );
        appendAICharacterLog(
          job.view,
          '角色能力已更新；后续按新权限重新规划，已有进度保留。',
        );
      }
      Object.assign(job.view, settings, { providerName: provider.name });
      this.bindVoice(job);
      await this.save();
      return this.list().find((v) => v.id === job.view.id)!;
    } finally {
      job.updating = false;
      this.schedule(job);
    }
  }

  async setVoice(id: string, value: unknown) {
    const job = this.jobs.get(id);
    if (!job) throw new AppError('Agent 不存在。', 404);
    if (
      this.closing ||
      isJobBusy(job) ||
      ['joining', 'stopping'].includes(job.view.status)
    )
      throw new AppError('Agent 状态正在更新，请稍候。', 409);
    const enabled = boolean(object(value).enabled, false);
    if (enabled && !aiCharacterPermissions(job.view).chat)
      throw new AppError('发送聊天权限已关闭，不能开启语音回复。');
    this.checkVoice({ ...job.view, voiceReplies: enabled });
    job.updating = true;
    try {
      if (job.session?.room) {
        const result = await this.voiceCoordinator.syncSessionVoice(
          job.session,
          enabled,
        );
        if (!result.ok) throw new AppError('语音开关未生效，请重试。', 409);
      }
      job.view.voiceReplies = enabled;
      this.bindVoice(job);
      await this.save();
      return this.list().find((v) => v.id === job.view.id)!;
    } finally {
      job.updating = false;
      this.schedule(job);
    }
  }

  private wake(job: Job) {
    if (!canWakeJob(job, this.closing)) return;
    this.taskScheduler.cancel(job.view.id);
    job.view.status = 'running';
    job.abort = new AbortController();
    job.done = this.execute(
      job,
      this.providers.getRuntime(job.view.providerId),
    );
  }

  private schedule(job: Job) {
    this.taskScheduler.cancel(job.view.id);
    if (!canWakeJob(job, this.closing)) return;
    if (job.attention.pending) {
      this.taskScheduler.wake(job.view.id, 0, () => this.wake(job));
    } else if (
      ['running', 'waiting'].includes(job.memory.task.current?.status ?? '')
    ) {
      this.taskScheduler.wake(
        job.view.id,
        job.memory.effects.follow ? 100 : nextIntervalMs(job.view),
        () => this.wake(job),
      );
    }
  }

  /** Host primitive only: stop the runner, then let Tasks commit the chosen transition. */
  private async withStoppedExecution<T>(
    id: string,
    change: () => Promise<T>,
  ): Promise<T> {
    const job = this.taskJob(id);
    if (isJobBusy(job) || ['joining', 'stopping'].includes(job.view.status))
      throw new AppError('Agent 状态正在更新，请稍候。', 409);
    job.controlling = true;
    this.taskScheduler.cancel(id);
    job.attention.clear();
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

  private async execute(job: Job, provider: SavedProvider, run = true) {
    if (job.storageFailed) {
      job.view.status = 'failed';
      return;
    }
    const ctx: ExecutionContext = {
      serverUrl:
        typeof this.serverUrl === 'string' ? this.serverUrl : this.serverUrl(),
      dependencies: this.dependencies,
      voiceServices: this.voiceServices,
      closing: () => this.closing,
      bindVoice: (j) => this.bindVoice(j),
      controlMessage: (targetId, op, identity, commandId, message) =>
        this.tasks.controlMessage(targetId, op, identity, commandId, message),
      wake: (j) => this.wake(j),
      schedule: (j) => this.schedule(j),
      save: () => this.save(),
      persist: () => {
        void this.persist();
      },
    };
    job.host ??= new AICharacterHost(job, ctx);
    return job.host.run(provider, run);
  }

  stop(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new AppError('Agent 不存在。', 404);
    if (
      job.view.status !== 'stopping' &&
      (resident(job) || job.view.status !== 'stopped')
    ) {
      this.taskScheduler.cancel(job.view.id);
      job.view.status = 'stopping';
      job.attention.clear();
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
        void this.persist();
      })();
    }
    return this.list().find((v) => v.id === job.view.id)!;
  }

  async remove(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new AppError('Agent 不存在。', 404);
    if (this.closing || isJobBusy(job))
      throw new AppError('Agent 状态正在更新，请稍候。', 409);
    job.controlling = true;
    try {
      this.stop(id);
      await job.done;
      const restoreTasks = this.tasks.detachAgent(id, job.view.name);
      this.jobs.delete(id);
      void this.persist();
      try {
        await this.flush();
      } catch (error) {
        restoreTasks();
        this.jobs.set(id, job);
        void this.persist();
        await this.flush().catch(() => {});
        throw error;
      }
    } finally {
      job.controlling = false;
    }
  }

  hasProviderReference(id: string) {
    return [...this.jobs.values()].some((job) => job.view.providerId === id);
  }

  async removeVoiceService(id: string) {
    await this.voiceCoordinator.removeVoiceService(id, () =>
      [...this.jobs.values()].some(
        (j) => j.updating || j.view.voiceServiceId === id,
      ),
    );
  }

  close(): Promise<void> {
    return (this.closePromise ??= this.shutdown());
  }

  private async shutdown() {
    this.taskScheduler.close();
    this.planScheduler.close();
    this.closing = true;
    for (const job of this.jobs.values()) {
      this.shutdownPresence.set(job.view.id, job.view.status);
      this.tasks.pauseForShutdown(job.view.id);
    }
    for (const id of this.jobs.keys()) this.stop(id);
    await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
    await this.save();
    this.events.close();
  }
}

export type AICharacterDependencies = {
  session: (url: string) => Session;
  runner: (
    config: AgentConfig,
    provider: SavedProvider,
  ) => Pick<AgentRunner, 'run'>;
};
