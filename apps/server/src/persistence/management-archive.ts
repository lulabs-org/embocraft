import { AppError } from '../core/errors/app-error';
import { stableJson } from '../core/database/stable-json';
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

export type TaskSnapshot = Pick<
  ManagementArchive,
  'plans' | 'runs' | 'requests'
>;
export type RecordChange<T> = { id: string; before?: T; after?: T };
export type TaskChanges = {
  plans: RecordChange<TaskPlan>[];
  runs: RecordChange<StoredRun>[];
  requests: RecordChange<string>[];
};

export type ManagementChange = CharacterChanges &
  ManagementArchive & {
    /** Explicit task writes; omitted only by full-snapshot import/legacy callers. */
    taskChanges?: TaskChanges;
  };

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
    ...(change.taskChanges
      ? applyTaskChanges(
          stored ?? { plans: [], runs: [], requests: {} },
          change.taskChanges,
        )
      : { plans: change.plans, runs: change.runs, requests: change.requests }),
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

// Compare only persisted task data: views and a Run's character memory are derived.
function planJson(plan: TaskSnapshot['plans'][number]) {
  const { latestRun: _latest, ...record } = plan;
  return stableJson(record);
}
function runJson(run: TaskSnapshot['runs'][number]) {
  const { runtime, ...record } = run;
  return stableJson({
    ...record,
    ...(runtime
      ? { runtime: { version: runtime.version, execution: runtime.execution } }
      : {}),
  });
}

function changes<T>(
  before: Map<string, T>,
  after: Map<string, T>,
  json: (record: T) => string,
): RecordChange<T>[] {
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((id) => {
    const old = before.get(id),
      next = after.get(id);
    if (old !== undefined && next !== undefined && json(old) === json(next))
      return [];
    return [{ id, before: old, after: next }];
  });
}
const byId = <T extends { id: string }>(records: T[]) =>
  new Map(records.map((record) => [record.id, record]));

/** Compute inside the serialized commit queue, against the last successful commit. */
export function taskChanges(
  before: TaskSnapshot,
  after: TaskSnapshot,
): TaskChanges {
  return {
    plans: changes(byId(before.plans), byId(after.plans), planJson),
    runs: changes(byId(before.runs), byId(after.runs), runJson),
    requests: changes(
      new Map(Object.entries(before.requests)),
      new Map(Object.entries(after.requests)),
      stableJson,
    ),
  };
}

function apply<T>(
  stored: Map<string, T>,
  entries: RecordChange<T>[],
  json: (record: T) => string,
) {
  for (const { id, before, after } of entries) {
    const current = stored.get(id);
    if (
      (current === undefined) !== (before === undefined) ||
      (current !== undefined &&
        before !== undefined &&
        json(current) !== json(before))
    )
      throw new AppError('任务记录已改变，请刷新并重新加载后重试。', 409);
    if (after === undefined) stored.delete(id);
    else stored.set(id, after);
  }
  return stored;
}

/** Untouched rows remain database-owned; stale updates/deletes fail atomically. */
export function applyTaskChanges(
  stored: TaskSnapshot,
  change: TaskChanges,
): TaskSnapshot {
  return {
    plans: [...apply(byId(stored.plans), change.plans, planJson).values()],
    runs: [...apply(byId(stored.runs), change.runs, runJson).values()],
    requests: Object.fromEntries(
      apply(
        new Map(Object.entries(stored.requests)),
        change.requests,
        stableJson,
      ),
    ),
  };
}
