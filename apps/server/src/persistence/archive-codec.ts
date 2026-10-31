import { isDeepStrictEqual } from 'node:util';
import type { RuntimeState } from '@voxel/agent-runtime';
import { AppError } from '../core/errors/app-error';
import type { ManagementArchive } from './archive';

type ArchivedRun = ManagementArchive['runs'][number];
type RunRecord = Omit<ArchivedRun, 'runtime'> & {
  runtime?: RuntimeState;
  runtimeRef?: { version: 1; characterId: string };
};

/** Storage v4 shares only the current run's identical runtime with its character row. */
export type StoredManagementArchive = Omit<
  ManagementArchive,
  'version' | 'runs'
> & {
  version: 4;
  runs: RunRecord[];
};

/** Execution archives exclude cumulative usage; historical conversations remain intact. */
function executionArchive(runtime: RuntimeState): RuntimeState {
  const copy = { ...runtime, character: { ...runtime.character } };
  delete copy.character.usage;
  return copy;
}

export function encodeArchive(
  archive: ManagementArchive,
): StoredManagementArchive {
  const characters = new Map(
    archive.characters.map((character) => [character.id, character]),
  );
  return {
    ...archive,
    version: 4,
    runs: archive.runs.map((run): RunRecord => {
      const character = characters.get(run.characterId ?? '');
      if (
        character?.currentRunId !== run.id ||
        !character.runtime ||
        !run.runtime ||
        !isDeepStrictEqual(executionArchive(character.runtime), run.runtime)
      )
        return run;
      const record: RunRecord = {
        ...run,
        runtimeRef: { version: 1, characterId: character.id },
      };
      delete record.runtime;
      return record;
    }),
  };
}

/** Accept legacy v3 snapshots and hydrate v4 references before domain recovery. */
export function decodeArchive(saved: unknown): ManagementArchive {
  const candidate = saved as Partial<StoredManagementArchive> | undefined;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    ![3, 4].includes(candidate.version!) ||
    !Array.isArray(candidate.characters) ||
    !Array.isArray(candidate.plans) ||
    !Array.isArray(candidate.runs) ||
    !candidate.requests ||
    typeof candidate.requests !== 'object' ||
    Array.isArray(candidate.requests)
  )
    throw new AppError('网关存档格式无效。', 500);
  const copy = structuredClone(candidate as StoredManagementArchive);
  const characters = new Map(
    copy.characters.map((character) => [character.id, character]),
  );
  const runs = copy.runs.map((run): ArchivedRun => {
    if (run.runtimeRef === undefined) return run;
    const ref = run.runtimeRef;
    const character = characters.get(ref?.characterId);
    if (
      copy.version !== 4 ||
      ref?.version !== 1 ||
      run.runtime !== undefined ||
      !character?.runtime ||
      character.currentRunId !== run.id ||
      run.characterId !== character.id
    )
      throw new AppError('执行运行时引用无效。', 500);
    const restored = {
      ...run,
      runtime: structuredClone(executionArchive(character.runtime)),
    };
    delete restored.runtimeRef;
    return restored;
  });
  return { ...copy, version: 3, runs };
}
