import {
  Session,
  type AgentConfig,
  type RuntimeModelOptions,
} from '@voxel/agent-runtime';
import type { AICharacterSettings } from '@voxel/shared';
import type { ManagementPersistence } from '../../../application/management-commit';
import { createManagementPersistence } from '../../../application/management-persistence';
import { AppError } from '../../../core/errors/app-error';
import { domainEvents } from '../../../core/events/domain-events';
import { DatabaseManagementArchive } from '../../../persistence/database-management-archive';
import type { ArchivePort } from '../../../persistence/management-archive';
import { migrateArchive } from '../../../persistence/migrate-archive';
import { bindConsoleSyncEvents, ConsoleSyncEvents } from '../../console-sync';
import {
  providerRepository,
  type ProviderRuntimePort,
  type SavedProvider,
} from '../../providers';
import { bindTaskService, TaskCoordinator, TaskSnapshots } from '../../tasks';
import { appendAICharacterLog } from '../domain/activity-log';
import { validateAICharacter } from '../domain/character-settings';
import { executionState } from '../integrations/task-execution-adapter';
import { CharacterVoiceCoordinator } from '../integrations/voice-coordinator';
import { CharacterSnapshots } from '../persistence/character-snapshots';
import type { AICharacterRoutePort } from '../ports';
import { CharacterExecutionService } from '../runtime/character-execution';
import { AICharacterRegistry, type Job } from '../runtime/character-registry';
import { AICharacterWakeScheduler } from '../runtime/wake-scheduler';
import { CharacterManagementService } from './character-management';
import { restoreAICharacterJob } from './character-restore';

let activeCharacterManager: AICharacterRoutePort | undefined;

export function bindCharacterManager(
  manager: AICharacterRoutePort,
): () => void {
  activeCharacterManager = manager;
  return () => {
    if (activeCharacterManager === manager) activeCharacterManager = undefined;
  };
}

export function getActiveCharacterManager(): AICharacterRoutePort {
  if (!activeCharacterManager)
    throw new AppError('AI 角色管理服务尚未就绪。', 503);
  return activeCharacterManager;
}

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
  private readonly execution: CharacterExecutionService;
  private readonly management: CharacterManagementService;

  private readonly releaseBindings: () => void;
  private closing = false;
  private restoreFailed = false;
  private closePromise?: Promise<void>;
  private shutdownPresence = new Map<string, Job['view']['status']>();

  constructor(
    private readonly providers: ProviderRuntimePort = providerRepository,
    private serverUrl: string | (() => string) = '',
    private dependencies: AICharacterDependencies,
    private archive: ArchivePort = new DatabaseManagementArchive(),
  ) {
    this.execution = new CharacterExecutionService({
      jobs: this.jobs,
      scheduler: this.taskScheduler,
      providers: this.providers,
      serverUrl: this.serverUrl,
      dependencies: this.dependencies,
      voice: this.voiceCoordinator,
      closing: () => this.closing,
      controlMessage: (...args) => this.tasks.controlMessage(...args),
      save: () => this.save(),
      persist: () => this.persist(),
    });
    const characters = new CharacterSnapshots();
    const tasks = new TaskSnapshots();
    this.persistence = createManagementPersistence(this.archive, {
      characters,
      tasks,
      captureExecutions: () =>
        tasks.captureExecutions([...this.jobs.values()].map(executionState)),
      captureCharacters: () =>
        characters.capture(this.jobs, () => this.list(), this.shutdownPresence),
      captureTasks: () => tasks.capture(this.plans),
      rejectTasks: (snapshot) => tasks.reject(snapshot, this.committedPlans),
      affectedCharacters: (records, affected) =>
        characters.affectedByFailure(records, affected),
      protectCharacters: (ids) =>
        this.execution.protectAfterStorageFailure(ids),
      commitCharacters: (records) => characters.commit(records),
      restoreTasks: (snapshot) => tasks.restore(this.committedPlans, snapshot),
      publishCommitted: (snapshot, views) =>
        this.events.commit(views, snapshot),
    });
    const releaseVoiceGuard = domainEvents.on(
      'tts.service.removing',
      ({ serviceId }) => {
        if (this.hasVoiceServiceReference(serviceId))
          throw new AppError(
            '有 Agent 正在引用此服务或保存参数，请先完成更新，并在编辑参数中更换或移除语音服务。',
            409,
          );
      },
    );
    const releaseProviderGuard = domainEvents.on(
      'provider.removing',
      ({ providerId }) => {
        if (this.hasProviderReference(providerId))
          throw new AppError(
            '已有可复用 Agent 关联此模型服务，请保留配置或更新其密钥。',
            409,
          );
      },
    );
    const releaseProviderChanged = domainEvents.on('provider.changed', () => {
      this.events.publish('providers');
    });
    this.tasks = new TaskCoordinator(
      {
        execution: (id) => executionState(this.execution.taskJob(id)),
        findExecution: (id) => {
          const job = this.jobs.get(id);
          return job ? executionState(job) : undefined;
        },
        executions: () => [...this.jobs.values()].map(executionState),
        save: () => this.save(),
        schedule: (id) => {
          const job = this.jobs.get(id);
          if (job) this.execution.schedule(job);
        },
        launch: (id) =>
          this.execution.launchReserved(this.execution.taskJob(id)),
        withStoppedExecution: (id, change) =>
          this.execution.withStoppedExecution(id, change),
        validateExecution: async (id, overrides) => {
          const job = this.execution.taskJob(id);
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
        publicIdentity: (id) => this.persistence.characters.publicIdentity(id),
        resourceVersion: () => this.events.version,
        isClosing: () => this.closing,
        assertWritable: (id) => this.assertWritable(id),
      },
      () =>
        this.archive instanceof DatabaseManagementArchive
          ? this.archive.readSnapshot()
          : this.archive.load(),
    );
    this.management = new CharacterManagementService({
      jobs: this.jobs,
      providers: this.providers,
      voice: this.voiceCoordinator,
      scheduler: this.taskScheduler,
      execution: this.execution,
      closing: () => this.closing,
      plans: () => this.plans,
      list: () => this.list(),
      save: () => this.save(),
      persist: () => this.persist(),
      flush: () => this.flush(),
      detachAgent: (...args) => this.tasks.detachAgent(...args),
    });
    const releaseCharacterBinding = bindCharacterManager(this);
    const releaseTaskBinding = bindTaskService(this.tasks);
    const releaseSyncEvents = bindConsoleSyncEvents(this.events);
    this.releaseBindings = () => {
      releaseVoiceGuard();
      releaseProviderGuard();
      releaseProviderChanged();
      releaseCharacterBinding();
      releaseTaskBinding();
      releaseSyncEvents();
    };
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
      job.done = this.execution.execute(
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

  create(value: unknown) {
    return this.management.create(value);
  }

  join(id: string) {
    return this.management.join(id);
  }

  update(id: string, value: unknown) {
    return this.management.update(id, value);
  }

  setVoice(id: string, value: unknown) {
    return this.management.setVoice(id, value);
  }

  remove(id: string) {
    return this.management.remove(id);
  }

  stop(id: string) {
    this.execution.stop(id);
    return this.list().find((view) => view.id === id)!;
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
    this.releaseBindings();
    this.taskScheduler.close();
    this.planScheduler.close();
    this.closing = true;
    for (const job of this.jobs.values()) {
      this.shutdownPresence.set(job.view.id, job.view.status);
      this.tasks.pauseForShutdown(job.view.id);
    }
    for (const id of this.jobs.keys()) this.execution.stop(id);
    await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
    await this.save();
    this.events.close();
  }
}

/** Manager wrapper with explicit persistence supplied by the host. */
export class AICharacterManager extends AICharacterOrchestrator {
  constructor(
    providers: ProviderRuntimePort = providerRepository,
    serverUrl: string | (() => string) = '',
    archive: ArchivePort = new DatabaseManagementArchive(),
    dependencies: AICharacterDependencies = {
      session: (url) => new Session(url),
      model: (_config, provider) => ({
        endpoint: { type: provider.type, baseUrl: provider.baseUrl },
        request: fetch,
      }),
    },
  ) {
    super(providers, serverUrl, dependencies, archive);
  }
}

export type AICharacterDependencies = {
  session: (url: string) => Session;
  model: (config: AgentConfig, provider: SavedProvider) => RuntimeModelOptions;
};
