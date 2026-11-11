import { AppError } from '../core/errors/app-error';
import type { RuntimeState } from '@voxel/agent-runtime';
import type {
  AICharacterSettings,
  AICharacterView,
  TaskPlan,
  TaskRun,
} from '@voxel/shared';

type StoredRun = TaskRun & {
  runtime?: RuntimeState;
  accountedTokens: number;
  requestId?: string;
  lastBatch?: string;
};

/** Archive wire shape. The owning modules use structurally matching runtime types. */
export type CharacterRecord = AICharacterSettings &
  Pick<AICharacterView, 'id' | 'createdAt' | 'status' | 'logEntries'> & {
    runtime?: RuntimeState;
    currentRunId?: string;
  };

export type ManagementArchive = {
  version: 3;
  characters: CharacterRecord[];
  plans: TaskPlan[];
  runs: StoredRun[];
  requests: Record<string, string>;
};

export interface ArchivePort {
  load(): Promise<ManagementArchive | undefined>;
  save(records: ManagementArchive): Promise<void>;
  /** Commit only participating characters; omitted offline characters remain untouched. */
  commit(change: ManagementChange): Promise<ManagementArchive>;
}

export type CharacterChanges = {
  create?: CharacterRecord;
  profiles?: Record<string, Partial<AICharacterSettings>>;
  remove?: string[];
};

export type ManagementChange = CharacterChanges & ManagementArchive;

/** Runtime checkpoints cannot overwrite configuration owned by the database. */
export function applyManagementChange(
  stored: ManagementArchive | undefined,
  change: ManagementChange,
): ManagementArchive {
  const characters = new Map(
    stored?.characters.map((record) => [record.id, record]),
  );
  if (change.create) {
    if (characters.size >= 50)
      throw new AppError('最多保存 50 个 Agent。', 409);
    if (characters.has(change.create.id))
      throw new AppError('Agent 已存在。', 409);
    characters.set(change.create.id, change.create);
  }
  for (const record of change.characters) {
    const previous = characters.get(record.id);
    if (!previous) throw new AppError('Agent 不存在。', 404);
    characters.set(record.id, {
      ...previous,
      ...change.profiles?.[record.id],
      status: record.status,
      runtime: record.runtime,
      currentRunId: record.currentRunId,
      logEntries: appendStoredLogs(previous.logEntries, record.logEntries),
    });
  }
  for (const id of change.remove ?? []) characters.delete(id);
  return {
    version: 3,
    characters: [...characters.values()],
    plans: change.plans,
    runs: change.runs,
    requests: change.requests,
  };
}

/** Preserve durable history when the runner advances its bounded recent-log window. */
function appendStoredLogs(
  previous: CharacterRecord['logEntries'],
  recent: CharacterRecord['logEntries'],
) {
  let overlap = Math.min(previous.length, recent.length);
  while (
    overlap > 0 &&
    !recent.slice(0, overlap).every((entry, index) => {
      const old = previous[previous.length - overlap + index];
      return old.time === entry.time && old.text === entry.text;
    })
  )
    overlap--;
  return [...previous, ...recent.slice(overlap)];
}
