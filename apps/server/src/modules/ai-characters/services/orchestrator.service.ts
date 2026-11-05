import {
  type AgentConfig,
  type RuntimeModelOptions,
  type Session,
} from '@voxel/agent-runtime';
import {
  aiCharacterPermissions,
  type AICharacterSettings,
} from '@voxel/shared';
import { randomUUID } from 'node:crypto';
import type { ArchivePort } from '../../../persistence/management-archive';
import { ManagementPersistence } from '../../../persistence/management-persistence';
import { migrateArchive } from '../../../persistence/migrate-archive';
import { ConsoleSyncEvents } from '../../console-sync';
import type { ProviderRuntimePort, SavedProvider } from '../../providers';
import { appendAICharacterLog } from '../domain/activity-log';
import { AICharacterWakeScheduler } from './wake-scheduler.service';

import { AppError } from '../../../core/errors/app-error';
import { boolean, object, text } from '../../../core/http/validation';
import {
  aiCharacterProfileInput,
  validateAICharacter,
} from '../domain/validation';

import {
  markJoined,
  markOffline,
  modelChanged,
  pauseTaskForHost,
  TaskCoordinator,
  TaskSnapshots,
} from '../../tasks';
import { restoreAICharacterJob } from '../persistence/restore';
import { CharacterSnapshots } from '../persistence/snapshots';
import { domainEvents } from '../../../core/events/domain-events';
import { AICharacterHost } from './character-host.service';
import type { ExecutionContext } from './execution-context';
import {
  active,
  AICharacterRegistry,
  canWakeJob,
  createCharacterJob,
  isJobBusy,
  resident,
  type Job,
} from './character-job';
import { executionState } from './task-execution-adapter';
import { CharacterVoiceCoordinator } from './voice-coordinator.service';

export class AICharacterOrchestrator {
  readonly jobs = new AICharacterRegistry();
  readonly events = new ConsoleSyncEvents();
  readonly taskScheduler = new AICharacterWakeScheduler();
  readonly persistence: ManagementPersistence<
    CharacterSnapshots,
    TaskSnapshots
  >;
  readonly tasks: TaskCoordinator;
  readonly voiceCoordinator = new CharacterVoiceCoordinator();

  private readonly releaseVoiceGuard: () => void;
  private closing = false;
  private restoreFailed = false;
  private closePromise?: Promise<void>;
  private shutdownPresence = new Map<string, Job['view']['status']>();

  constructor(
    private readonly providers: ProviderRuntimePort,
    private serverUrl: string | (() => string),
    private dependencies: AICharacterDependencies,
    private archive: ArchivePort,
  ) {
    const characters = new CharacterSnapshots();
    const tasks = new TaskSnapshots();
    this.persistence = new ManagementPersistence(
      this.archive,
      (snapshot, views) => {
        // Notifications still observe both durable runtime and derived public fields.
        const publicViews = new Map(views.map((view) => [view.id, view]));
        this.events.commit(
          snapshot.characters.map((record) => ({
            ...publicViews.get(record.id),
            ...record,
            sessionId: undefined,
          })),
          snapshot,
        );
      },
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
        commitCharacters: (records) => characters.commit(records),
        restoreTasks: (snapshot) =>
          tasks.restore(this.committedPlans, snapshot),
      },
    );
    this.releaseVoiceGuard = domainEvents.on(
      'tts.service.removing',
      ({ serviceId }) => {
        if (this.hasVoiceServiceReference(serviceId))
          throw new AppError(
            '有 Agent 正在引用此服务或保存参数，请先完成更新，并在编辑参数中更换或移除语音服务。',
            409,
          );
      },
    );
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
      validateExecution: async (id, overrides) => {
        const job = this.taskJob(id);
        const settings = validateAICharacter(
          { ...job.view, ...overrides },
          await this.providers.getRuntime(job.view.providerId),
        );
        await this.checkVoice(settings);
        return settings;
      },
      storageFailed: () => this.persistence.tasks.storageFailed,
      committedName: (id) =>
        this.persistence.characters.committedCharacterName(id),
      publicIdentity: (id) => characters.publicIdentity(id),
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
      const { job, voiceWarning, shouldAutoJoin } = await restoreAICharacterJob(
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
        await this.providers.getRuntime(job.view.providerId),
        false,
      );
      await job.done;
    }
    this.planScheduler.start();
  }

  currentRunId(id: string) {
    return this.jobs.get(id)?.currentRunId;
  }

  sessionId(id: string) {
    return this.jobs.get(id)?.view.sessionId;
  }

  taskIdentity(id: string) {
    return this.jobs.get(id)?.runtime.view().identity;
  }

  private checkVoice(settings: AICharacterSettings) {
    return this.voiceCoordinator.checkVoice(settings);
  }

  private bindVoice(job: Job, settings?: AICharacterSettings) {
    return this.voiceCoordinator.bindVoice(job, settings);
  }

  list() {
    return [...this.jobs.values()]
      .map(({ view, runtime, currentRunId }) => {
        const state = runtime.view();
        const run = this.plans.runs.find((run) => run.id === currentRunId);
        return structuredClone({
          ...view,
          task: state.task,
          taskExecution: run
            ? {
                runId: run.id,
                limits: run.snapshot.limits,
                source: run.source,
                action: state.action
                  ? {
                      id: state.action.id,
                      name: state.action.name,
                      status: state.action.status,
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
          usage: state.usage,
          lastResponse: state.lastResponse,
          taskRequiresReassignment: state.requiresReassignment,
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
    job.done = this.execute(job);
  }

  async create(value: unknown) {
    if (this.closing) throw new AppError('世界服务正在关闭。', 503);
    const input = aiCharacterProfileInput(value);
    const provider = await this.providers.getRuntime(
      text(input.providerId, '模型服务', 80),
    );
    const settings = validateAICharacter(input, provider);
    const joinWorld = boolean(input.joinWorld, true);
    await this.checkVoice(settings);
    if (this.closing) throw new AppError('世界服务正在关闭。', 503);
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
    const job = createCharacterJob({
      view: {
        ...settings,
        id: randomUUID(),
        providerName: provider.name,
        status: joinWorld ? 'joining' : 'stopped',
        createdAt: Date.now(),
        logEntries: [],
      },
      abort: new AbortController(),
      ledger: this.plans,
    });
    this.jobs.set(job.view.id, job);
    if (joinWorld) job.done = this.execute(job, provider, false);
    void this.persist();
    return this.list().find((v) => v.id === job.view.id)!;
  }

  async join(id: string) {
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
    const previousStatus = job.view.status;
    job.updating = true;
    job.view.status = 'joining';
    job.abort = new AbortController();
    try {
      const provider = await this.providers.getRuntime(job.view.providerId);
      if (
        this.closing ||
        this.jobs.get(id) !== job ||
        job.abort.signal.aborted ||
        job.view.status !== 'joining'
      )
        throw new AppError('角色状态已变化，请刷新后重试。', 409);
      const settings = validateAICharacter(job.view, provider);
      await this.checkVoice(settings);
      if (
        this.closing ||
        this.jobs.get(id) !== job ||
        job.abort.signal.aborted ||
        job.view.status !== 'joining'
      )
        throw new AppError('角色状态已变化，请刷新后重试。', 409);
      if ([...this.jobs.values()].filter(resident).length > 4)
        throw new AppError(
          '最多同时在线 4 个 Agent，请先让一个角色离开世界。',
          409,
        );
      this.taskScheduler.cancel(job.view.id);
      markJoined(executionState(job));
      Object.assign(job.view, settings, {
        providerName: provider.name,
        status: 'joining',
      });
      job.runtime.clearMessages();
      job.done = this.execute(job, provider, false);
      void this.persist();
      return this.list().find((v) => v.id === id)!;
    } catch (error) {
      if (job.view.status === 'joining') job.view.status = previousStatus;
      throw error;
    } finally {
      job.updating = false;
    }
  }

  async update(id: string, value: unknown) {
    if (this.closing) throw new AppError('世界服务正在关闭。', 503);
    const job = this.jobs.get(id);
    if (!job) throw new AppError('Agent 不存在。', 404);
    const input = aiCharacterProfileInput(value);
    if (active(job.view.status) || isJobBusy(job))
      throw new AppError('请等待 Agent 待命，或关闭后再修改参数。', 409);
    job.updating = true;
    try {
      const provider = await this.providers.getRuntime(
        text(input.providerId, '模型服务', 80, job.view.providerId),
      );
      if (this.closing || this.jobs.get(id) !== job || active(job.view.status))
        throw new AppError('角色状态已变化，请刷新后重试。', 409);
      const settings = validateAICharacter(
        {
          ...job.view,
          ...input,
          permissions:
            input.permissions !== undefined
              ? input.permissions
              : job.view.permissions,
        },
        provider,
      );
      await this.checkVoice(settings);
      if (this.closing || this.jobs.get(id) !== job || active(job.view.status))
        throw new AppError('角色状态已变化，请刷新后重试。', 409);
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
      await this.bindVoice(job, settings);
      if (
        this.closing ||
        this.jobs.get(id) !== job ||
        job.session !== session ||
        active(job.view.status)
      )
        throw new AppError('角色状态已变化，请刷新后重试。', 409);
      if (
        settings.providerId !== job.view.providerId ||
        settings.model !== job.view.model
      ) {
        this.taskScheduler.cancel(job.view.id);
        modelChanged(executionState(job));
        job.runtime.clearMessages();
      } else if (
        JSON.stringify(aiCharacterPermissions(settings)) !==
          JSON.stringify(aiCharacterPermissions(job.view)) ||
        JSON.stringify(settings.skills) !== JSON.stringify(job.view.skills)
      ) {
        this.taskScheduler.cancel(job.view.id);
        job.runtime.clearMessages();
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
    job.updating = true;
    try {
      await this.checkVoice({ ...job.view, voiceReplies: enabled });
      if (this.closing || this.jobs.get(id) !== job)
        throw new AppError('角色状态已变化，请刷新后重试。', 409);
      const session = job.session;
      if (session?.room) {
        const result = await this.voiceCoordinator.syncSessionVoice(
          session,
          enabled,
        );
        if (!result.ok || job.session !== session)
          throw new AppError('语音开关未生效，请重试。', 409);
      }
      await this.bindVoice(job, { ...job.view, voiceReplies: enabled });
      if (
        this.closing ||
        this.jobs.get(id) !== job ||
        job.session !== session ||
        ['joining', 'stopping'].includes(job.view.status)
      )
        throw new AppError('角色状态已变化，请刷新后重试。', 409);
      job.view.voiceReplies = enabled;
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
    job.done = this.execute(job);
  }

  private schedule(job: Job) {
    this.taskScheduler.cancel(job.view.id);
    if (!canWakeJob(job, this.closing)) return;
    const delay = job.runtime.nextWakeDelay({ ...job.view, apiKey: '' });
    if (delay !== undefined)
      this.taskScheduler.wake(job.view.id, delay, () => this.wake(job));
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

  private async execute(job: Job, provider?: SavedProvider, run = true) {
    if (job.storageFailed) {
      job.view.status = 'failed';
      return;
    }
    if (!provider) {
      try {
        provider = await this.providers.getRuntime(job.view.providerId);
      } catch (error) {
        if (!job.abort.signal.aborted && !this.closing) {
          job.view.status = 'failed';
          appendAICharacterLog(
            job.view,
            error instanceof AppError
              ? error.message
              : '无法读取模型服务配置。',
          );
          void this.persist();
        }
        return;
      }
      if (job.abort.signal.aborted || this.closing) return;
    }
    const ctx: ExecutionContext = {
      serverUrl:
        typeof this.serverUrl === 'string' ? this.serverUrl : this.serverUrl(),
      dependencies: this.dependencies,
      unbindVoice: (sessionId) => this.voiceCoordinator.unbindVoice(sessionId),
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

  hasVoiceServiceReference(id: string) {
    return [...this.jobs.values()].some(
      (j) => j.updating || j.view.voiceServiceId === id,
    );
  }

  close(): Promise<void> {
    return (this.closePromise ??= this.shutdown());
  }

  private async shutdown() {
    this.releaseVoiceGuard();
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
  model: (config: AgentConfig, provider: SavedProvider) => RuntimeModelOptions;
};
