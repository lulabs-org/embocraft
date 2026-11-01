import type {
  Prisma,
  AgentCharacter,
  AgentCharacterState,
  AgentCharacterLog,
} from '@prisma/client';
import { databaseJson } from '../core/database/client';
import type { CharacterRecord, ManagementArchive } from './archive';
import type { RuntimeState } from '@voxel/agent-runtime';
import { stableJson } from './stable-json';

type Log = { sequence: number; time: number | null; text: string };
export type SavedCharacter = {
  config: ReturnType<typeof configuration>;
  state: {
    status: string | null;
    currentRunId: string | null;
    runtimeVersion: number | null;
    memory: Prisma.InputJsonValue | null;
    standby: Prisma.InputJsonValue | null;
  };
  logs: Log[];
};

function json(value: unknown) {
  return value == null
    ? null
    : (JSON.parse(stableJson(value)) as Prisma.InputJsonValue);
}

function configuration(record: CharacterRecord, position: number) {
  return {
    id: record.id,
    providerId: record.providerId,
    position,
    name: record.name ?? null,
    model: record.model ?? null,
    goal: record.goal ?? null,
    roleDescription: record.roleDescription ?? null,
    taskLimitsEnabled: record.taskLimitsEnabled ?? null,
    maxTurns: record.maxTurns ?? null,
    maxStalledTurns: record.maxStalledTurns ?? null,
    tokenBudget: record.tokenBudget ?? null,
    taskTimeoutMs: record.taskTimeoutMs ?? null,
    intervalMode: record.intervalMode ?? null,
    intervalMinMs: record.intervalMinMs ?? null,
    intervalMaxMs: record.intervalMaxMs ?? null,
    intervalMs: record.intervalMs ?? null,
    timeoutMs: record.timeoutMs ?? null,
    maxTokens: record.maxTokens ?? null,
    permissions: json(record.permissions),
    skills: json(record.skills),
    voiceReplies: record.voiceReplies ?? null,
    voiceServiceId: record.voiceServiceId ?? null,
    thinking: record.thinking ?? null,
    reasoningEffort: record.reasoningEffort ?? null,
    createdAt: record.createdAt ?? null,
  };
}

/** Keep retained log identities stable when the bounded in-memory window advances. */
export function captureCharacter(
  record: CharacterRecord,
  position: number,
  previous?: SavedCharacter,
): SavedCharacter {
  const entries = record.logEntries ?? [];
  const old = previous?.logs ?? [];
  let overlap = Math.min(old.length, entries.length);
  while (
    overlap > 0 &&
    !entries.slice(0, overlap).every((entry, index) => {
      const prior = old[old.length - overlap + index];
      return entry.time === prior.time && entry.text === prior.text;
    })
  )
    overlap--;
  const last = old.at(-1)?.sequence ?? 0;
  const logs = [
    ...old.slice(old.length - overlap),
    ...entries
      .slice(overlap)
      .map((entry, index) => ({ ...entry, sequence: last + index + 1 })),
  ];
  return {
    config: configuration(record, position),
    state: {
      status: record.status ?? null,
      currentRunId: record.currentRunId ?? null,
      runtimeVersion: record.runtime?.version ?? null,
      memory: json(record.runtime?.character),
      standby: record.currentRunId ? null : json(record.runtime?.execution),
    },
    logs,
  };
}

export function restoreCharacter(
  row: AgentCharacter & {
    state: AgentCharacterState | null;
    logs: AgentCharacterLog[];
  },
  runs: Map<string, ManagementArchive['runs'][number]>,
): CharacterRecord {
  if (!row.state) throw new Error('Character recovery state is missing.');
  const { position: _position, state, logs, ...config } = row;
  const { status, currentRunId } = state;
  let runtime: RuntimeState | undefined;
  if (state.runtimeVersion !== null) {
    if (state.runtimeVersion !== 4 || !state.memory)
      throw new Error('Character memory is invalid.');
    const run = currentRunId ? runs.get(currentRunId) : undefined;
    if (
      currentRunId &&
      (!run?.runtime || run.characterId !== row.id || state.standby !== null)
    )
      throw new Error(
        'Current execution checkpoint is missing or belongs to another character.',
      );
    const execution = run?.runtime?.execution ?? state.standby;
    if (!execution) throw new Error('Character standby state is missing.');
    runtime = {
      version: 4,
      character: structuredClone(
        state.memory,
      ) as unknown as RuntimeState['character'],
      execution: structuredClone(execution) as RuntimeState['execution'],
    };
  } else if (currentRunId || state.memory !== null || state.standby !== null) {
    throw new Error('Character runtime version is missing.');
  }
  const recovery = { status, currentRunId };
  // Missing optional legacy settings stay absent so domain defaults still apply.
  return {
    ...Object.fromEntries(
      Object.entries(config).filter(([, value]) => value !== null),
    ),
    ...Object.fromEntries(
      Object.entries(recovery).filter(([, value]) => value !== null),
    ),
    ...(runtime ? { runtime } : {}),
    logEntries: logs.map(({ time, text }) => ({ time, text })),
  } as CharacterRecord;
}

/** All three tables participate in the caller's joint character/task transaction. */
export async function saveCharacter(
  tx: Prisma.TransactionClient,
  next: SavedCharacter,
  previous?: SavedCharacter,
) {
  const id = next.config.id;
  if (!previous || stableJson(next.config) !== stableJson(previous.config)) {
    const data = {
      ...next.config,
      permissions: databaseJson(next.config.permissions),
      skills: databaseJson(next.config.skills),
    };
    await tx.agentCharacter.upsert({
      where: { id },
      create: data,
      update: data,
    });
  }
  if (!previous || stableJson(next.state) !== stableJson(previous.state)) {
    const data = {
      ...next.state,
      memory: databaseJson(next.state.memory),
      standby: databaseJson(next.state.standby),
    };
    await tx.agentCharacterState.upsert({
      where: { characterId: id },
      create: { characterId: id, ...data },
      update: data,
    });
  }
  const retained = new Set(next.logs.map((entry) => entry.sequence));
  const removed =
    previous?.logs
      .filter((entry) => !retained.has(entry.sequence))
      .map((entry) => entry.sequence) ?? [];
  if (removed.length)
    await tx.agentCharacterLog.deleteMany({
      where: { characterId: id, sequence: { in: removed } },
    });
  const old = new Set(previous?.logs.map((entry) => entry.sequence));
  const added = next.logs.filter((entry) => !old.has(entry.sequence));
  if (added.length)
    await tx.agentCharacterLog.createMany({
      data: added.map((entry) => ({ characterId: id, ...entry })),
    });
}
