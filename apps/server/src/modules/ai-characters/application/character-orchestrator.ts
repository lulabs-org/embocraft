import type {
  Session,
  AgentConfig,
  RuntimeModelOptions,
} from '@voxel/agent-runtime';
import { type AICharacterSettings, type AICharacterView } from '@voxel/shared';
import type { ManagementPersistence } from '../../../application/management-commit';
import { createManagementPersistence } from '../../../application/management-persistence';
import { AppError } from '../../../core/errors/app-error';
import { domainEvents } from '../../../core/events/domain-events';
import type {
  CharacterChanges,
  CharacterRecord,
} from '../../../persistence/management-archive';
import type { ManagementStore } from '../../../persistence/management-store';
import { migrateArchive } from '../../../persistence/migrate-archive';
import { bindConsoleSyncEvents, ConsoleSyncEvents } from '../../console-sync';
import { type ProviderRuntimePort, type SavedProvider } from '../../providers';
import {
  bindTaskService,
  markOffline,
  TaskCoordinator,
  TaskSnapshots,
} from '../../tasks';
import { appendAICharacterLog } from '../domain/activity-log';
import { validateAICharacter } from '../domain/character-settings';
import { taskExecutionState } from '../integrations/task-execution-adapter';
import { CharacterVoiceCoordinator } from '../integrations/voice-coordinator';
import { CharacterSnapshots } from '../persistence/character-snapshots';
import type { AICharacterRoutePort } from '../ports';
import { CharacterExecutionService } from '../runtime/character-execution';
import {
  AICharacterRegistry,
  active,
  type Job,
} from '../runtime/character-registry';
import { AICharacterWakeScheduler } from '../runtime/wake-scheduler';
import { CharacterManagementService } from './character-management';
import { CharacterOperations } from './character-operations';
import { characterSettings } from '../persistence/character-record';
import { restoreAICharacterJob } from './character-restore';

let activeCharacterOrchestrator: AICharacterRoutePort | undefined;

export function bindCharacterOrchestrator(
  manager: AICharacterRoutePort,
): () => void {
  activeCharacterOrchestrator = manager;
  return () => {
    if (activeCharacterOrchestrator === manager)
      activeCharacterOrchestrator = undefined;
  };
}

export function getActiveCharacterOrchestrator(): AICharacterRoutePort {
  if (!activeCharacterOrchestrator)
    throw new AppError('AI 角色管理服务尚未就绪。', 503);
  return activeCharacterOrchestrator;
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
  private readonly operations: CharacterOperations;

  private readonly releaseBindings: () => void;
  private closing = false;
  private restoreFailed = false;
  private readonly failedCharacters = new Set<string>();
  private closePromise?: Promise<void>;
  private shutdownPresence = new Map<string, Job['view']['status']>();

  constructor(
    private readonly providers: ProviderRuntimePort,
    private serverUrl: string | (() => string),
    private dependencies: AICharacterDependencies,
    private archive: ManagementStore,
  ) {
    this.operations = new CharacterOperations(
      this.jobs,
      this.archive.characters,
      () => this.plans,
      (job) => this.releaseOffline(job),
    );
    this.execution = new CharacterExecutionService({
      jobs: this.jobs,
      release: (job) => this.releaseOffline(job),
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
      captureExecutions: (exclude) =>
        tasks.captureExecutions(
          this.participatingJobs()
            .filter((job) => !exclude?.includes(job.view.id))
            .map(taskExecutionState),
        ),
      captureCharacters: () =>
        characters.capture(
          new Map(this.participatingJobs().map((job) => [job.view.id, job])),
          () => this.runtimeViews(),
          this.shutdownPresence,
        ),
      captureTasks: () => tasks.capture(this.plans),
      captureCommittedTasks: () => tasks.capture(this.committedPlans),
      rejectTasks: (snapshot) => tasks.reject(snapshot, this.committedPlans),
      affectedCharacters: (records, affected) =>
        characters.affectedByFailure(records, affected),
      protectCharacters: (ids) => {
        ids.forEach((id) => this.failedCharacters.add(id));
        this.execution.protectAfterStorageFailure(ids);
      },
      commitCharacters: (records) =>
        characters.commit(records.filter((record) => this.jobs.has(record.id))),
      restoreTasks: (snapshot) => tasks.restore(this.committedPlans, snapshot),
      publishCommitted: (snapshot, views) =>
        this.events.commit(views, snapshot),
    });
    const releaseVoiceGuard = domainEvents.on(
      'tts.service.removing',
      async ({ serviceId }) => {
        if (await this.hasVoiceServiceReference(serviceId))
          throw new AppError(
            '有 Agent 正在引用此服务或保存参数，请先完成更新，并在编辑参数中更换或移除语音服务。',
            409,
          );
      },
    );
    const releaseProviderGuard = domainEvents.on(
      'provider.removing',
      async ({ providerId }) => {
        if (await this.hasProviderReference(providerId))
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
        execution: (id) => {
          const job = this.operations.get(id);
          if (!job) throw new AppError('请先让角色上线。', 409);
          return taskExecutionState(job);
        },
        withExecution: (id, action) => this.operations.run(id, action),
        readCharacter: async (id) => await this.record(id),
        findExecution: (id) => {
          const job = this.operations.get(id);
          return job ? taskExecutionState(job) : undefined;
        },
        executions: () => [...this.jobs.values()].map(taskExecutionState),
        save: () => this.save(),
        schedule: (id) => {
          const job = this.jobs.get(id);
          if (job) this.execution.schedule(job);
        },
        launch: (id) =>
          this.execution.launchReserved(this.execution.taskJob(id)),
        withStoppedExecution: (id, change) =>
          this.jobs.has(id)
            ? this.execution.withStoppedExecution(id, change)
            : change(),
        validateExecution: async (id, overrides) => {
          const job = this.operations.get(id);
          if (!job) throw new AppError('Agent 不存在。', 404);
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
      this.archive.tasks,
    );
    this.management = new CharacterManagementService({
      jobs: this.jobs,
      providers: this.providers,
      voice: this.voiceCoordinator,
      scheduler: this.taskScheduler,
      execution: this.execution,
      closing: () => this.closing,
      findJob: (id) => this.operations.get(id),
      result: (id) => this.get(id),
      read: (id) => this.record(id),
      insert: (record) => this.save({ create: record }),
      join: (id) => this.join(id),
      save: (changes) => this.save(changes),
      detachAgent: (...args) => this.tasks.detachAgent(...args),
    });
    const releaseCharacterBinding = bindCharacterOrchestrator(this);
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
      id
        ? this.failedCharacters.has(id) || this.jobs.get(id)?.storageFailed
        : undefined,
    );
  }

  async settled(id: string) {
    await this.jobs.get(id)?.done;
    await this.flush();
  }

  private persist(changes: CharacterChanges = {}) {
    // Shutdown also runs after failed startup; never replace unread/partially restored data.
    if (this.restoreFailed) return Promise.resolve();
    return this.persistence.persist(changes);
  }

  private save(changes: CharacterChanges = {}): Promise<void> {
    return this.persist(changes);
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
    this.persistence.tasks.restore(this.committedPlans, structuredClone(raw!));
    const autoJoin: string[] = [];
    const recovered: CharacterRecord[] = [];
    const profiles: NonNullable<CharacterChanges['profiles']> = {};
    for (const view of saved.characters) {
      const { job, voiceWarning, shouldAutoJoin } = await restoreAICharacterJob(
        view,
        this.providers,
        (settings) => this.checkVoice(settings),
        this.plans,
      );
      // Keep only serialized recovery data; do not retain offline execution instances.
      if (voiceWarning) appendAICharacterLog(job.view, voiceWarning);
      this.persistence.tasks.captureExecutions([taskExecutionState(job)]);
      profiles[view.id] = characterSettings(job.view);
      recovered.push({
        ...view,
        ...characterSettings(job.view),
        status: job.view.status,
        logEntries: job.view.logEntries,
        runtime: job.runtime.snapshot(),
        currentRunId: job.currentRunId,
      });
      if (shouldAutoJoin) autoJoin.push(view.id);
    }
    // Validate every record before writing any recovery changes.
    await this.persistence.persist({ profiles }, recovered);
    for (const id of autoJoin.slice(0, 4)) {
      await this.operations.run(id, () => this.management.join(id, true));
      await this.settled(id);
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

  private runtimeViews() {
    return this.participatingJobs()
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

  private participatingJobs() {
    return [...new Map([...this.operations.pending, ...this.jobs]).values()];
  }

  private releaseOffline(job: Job) {
    if (job.session || active(job.view.status)) return;
    if (this.jobs.get(job.view.id) === job) this.jobs.delete(job.view.id);
    this.taskScheduler.cancel(job.view.id);
    this.persistence.characters.forget(job.view.id);
  }

  private record(id: string): Promise<CharacterRecord> {
    return this.archive.characters.record(id);
  }

  async list(): Promise<AICharacterView[]> {
    return (await this.archive.characters.views()).map((view) => ({
      ...view,
      sessionId: this.sessionId(view.id),
    }));
  }

  private async get(id: string) {
    return {
      ...(await this.archive.characters.view(id)),
      sessionId: this.sessionId(id),
    };
  }

  async create(value: unknown) {
    this.assertWritable();
    return this.management.create(value);
  }

  async join(id: string) {
    this.assertWritable(id);
    return this.operations.run(id, () => this.management.join(id));
  }

  async update(id: string, value: unknown) {
    this.assertWritable(id);
    return this.operations.run(id, () => this.management.update(id, value));
  }

  async setVoice(id: string, value: unknown) {
    this.assertWritable(id);
    return this.operations.run(id, () => this.management.setVoice(id, value));
  }

  remove(id: string) {
    return this.operations.run(id, () => this.management.remove(id));
  }

  async stop(id: string) {
    if (!this.jobs.has(id)) {
      return this.operations.run(id, async () => {
        const job = this.operations.get(id)!;
        if (job.view.status !== 'stopped') {
          job.view.status = 'stopped';
          markOffline(taskExecutionState(job));
          await this.save();
        }
        return this.get(id);
      });
    }
    this.execution.stop(id);
    await this.settled(id);
    return this.get(id);
  }

  async hasProviderReference(id: string) {
    return (
      (await this.archive.characters.hasProviderReference(id)) ||
      this.participatingJobs().some((job) => job.view.providerId === id)
    );
  }

  async hasVoiceServiceReference(id: string) {
    return (
      (await this.archive.characters.hasVoiceServiceReference(id)) ||
      this.participatingJobs().some(
        (job) => job.updating || job.view.voiceServiceId === id,
      )
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

export type AICharacterDependencies = {
  session: (url: string) => Session;
  model: (config: AgentConfig, provider: SavedProvider) => RuntimeModelOptions;
};
