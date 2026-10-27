import type { AICharacterView } from '@voxel/shared';
import { AppError } from '../core/errors/app-error';
import type { ArchivePort, ManagementArchive } from './archive';
import type { ManagementEvents } from '../modules/management/events';
import type { AICharacterRegistry } from '../modules/ai-characters/runtime/job';
import type { AICharacterWakeScheduler } from '../modules/ai-characters/runtime/wake-scheduler';
import { executionState } from '../modules/ai-characters/runtime/task-adapter';
import { CharacterSnapshots } from '../modules/ai-characters/persistence/snapshots';
import { TaskSnapshots } from '../modules/tasks/persistence/snapshots';
import type { PlanService } from '../modules/tasks/persistence/service';

/** One serialized commit owns the character/task envelope and its visibility boundary. */
export class ManagementPersistence {
  private saving: Promise<void> = Promise.resolve();
  readonly characters = new CharacterSnapshots();
  readonly tasks = new TaskSnapshots();
  storageRevision = 0;

  constructor(
    private readonly archive: ArchivePort,
    private readonly events: ManagementEvents,
  ) {}

  assertWritable(closing: boolean, jobStorageFailed?: boolean) {
    if (closing) throw new AppError('世界服务正在关闭。', 503);
    if (jobStorageFailed)
      throw new AppError(
        '存档失败，已停止此 Agent 的后续动作。请修复存储后重启服务。',
        503,
      );
  }

  async flush(since = this.storageRevision): Promise<void> {
    await this.saving;
    if (since !== this.storageRevision)
      throw new AppError('保存失败，操作结果待确认，请检查存储。', 503);
  }

  persist(
    jobs: AICharacterRegistry,
    plans: PlanService,
    committedPlans: PlanService,
    taskScheduler: AICharacterWakeScheduler,
    list: () => AICharacterView[],
    shutdownPresence: Map<string, AICharacterView['status']>,
  ): Promise<void> {
    this.tasks.captureExecutions([...jobs.values()].map(executionState));
    const { records, views } = this.characters.capture(
      jobs,
      list,
      shutdownPresence,
    );
    const snapshot: ManagementArchive = {
      version: 3,
      characters: records,
      ...this.tasks.capture(plans),
    };
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        try {
          await this.archive.save(snapshot);
        } catch (error) {
          this.storageRevision++;
          const affected = this.tasks.reject(snapshot, committedPlans);
          this.characters.reject(records, jobs, affected, (id) =>
            taskScheduler.cancel(id),
          );
          throw error;
        }
        this.characters.commit(records, views);
        this.tasks.restore(committedPlans, snapshot);
        this.events.commit(records, snapshot);
      });
    void this.saving.catch(() => console.error('无法保存 Agent 记录。'));
    return this.saving;
  }
}
