import type { AICharacterView } from '@voxel/shared';
import { AppError } from '../core/errors/app-error';
import type {
  ArchivePort,
  CharacterRecord,
  ManagementArchive,
} from './archive';

type TaskSnapshot = Pick<ManagementArchive, 'plans' | 'runs' | 'requests'>;

export type ManagementSnapshotPorts<Characters, Tasks> = {
  characters: Characters;
  tasks: Tasks;
  captureExecutions(): void;
  captureCharacters(): { records: CharacterRecord[]; views: AICharacterView[] };
  captureTasks(): TaskSnapshot;
  rejectTasks(snapshot: TaskSnapshot): Set<string | undefined>;
  rejectCharacters(
    records: CharacterRecord[],
    affected: Set<string | undefined>,
  ): void;
  commitCharacters(records: CharacterRecord[], views: AICharacterView[]): void;
  restoreTasks(snapshot: TaskSnapshot): void;
};

/** One serialized commit owns the character/task envelope and its visibility boundary.
 * The caller wires notifications after both committed views have been updated.
 */
export class ManagementPersistence<Characters, Tasks> {
  private saving: Promise<void> = Promise.resolve();
  storageRevision = 0;

  constructor(
    private readonly archive: ArchivePort,
    private readonly onCommitted: (
      snapshot: ManagementArchive,
      views: AICharacterView[],
    ) => void,
    private readonly snapshots: ManagementSnapshotPorts<Characters, Tasks>,
  ) {}

  get characters(): Characters {
    return this.snapshots.characters;
  }

  get tasks(): Tasks {
    return this.snapshots.tasks;
  }

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

  persist(): Promise<void> {
    this.snapshots.captureExecutions();
    const { records, views } = this.snapshots.captureCharacters();
    const snapshot: ManagementArchive = {
      version: 3,
      characters: records,
      ...this.snapshots.captureTasks(),
    };
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        try {
          await this.archive.save(snapshot);
        } catch (error) {
          this.storageRevision++;
          const affected = this.snapshots.rejectTasks(snapshot);
          this.snapshots.rejectCharacters(records, affected);
          throw error;
        }
        this.snapshots.commitCharacters(records, views);
        this.snapshots.restoreTasks(snapshot);
        this.onCommitted(snapshot, views);
      });
    void this.saving.catch(() => console.error('无法保存 Agent 记录。'));
    return this.saving;
  }
}
