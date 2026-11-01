import type { AgentRun, AgentRunCheckpoint, Prisma } from '@prisma/client';
import type { RuntimeState } from '@voxel/agent-runtime';
import type { ManagementArchive } from './archive';
import { stableJson } from './stable-json';
import { databaseJson } from '../core/database/client';
import {
  counter,
  counterNumber,
  timestamp,
  taskJson,
  withoutNullFields,
} from './task-storage-values';

type StoredRun = ManagementArchive['runs'][number];
export type SavedRun = {
  id: string;
  position: number;
  serialized: string;
  checkpoint?: { version: number; execution: Prisma.InputJsonValue };
};

export function captureRun(run: StoredRun, position: number): SavedRun {
  const { runtime, ...metadata } = run;
  if (runtime && (runtime.version !== 4 || !runtime.execution))
    throw new Error('Unsupported execution checkpoint.');
  return {
    id: run.id,
    position,
    serialized: stableJson(metadata),
    checkpoint: runtime
      ? {
          version: runtime.version,
          execution: JSON.parse(
            stableJson(runtime.execution),
          ) as Prisma.InputJsonValue,
        }
      : undefined,
  };
}

export function restoreRun(
  row: AgentRun & { checkpoint: AgentRunCheckpoint | null },
): StoredRun {
  const {
    position: _position,
    checkpoint: _checkpoint,
    scheduledAt,
    startedAt,
    finishedAt,
    lastTriggerAt,
    totalTokens,
    accountedTokens,
    ...metadata
  } = row;
  if (row.checkpoint && row.checkpoint.version !== 4)
    throw new Error('Unsupported execution checkpoint.');
  return {
    ...withoutNullFields(metadata),
    scheduledAt: scheduledAt.getTime(),
    ...(startedAt !== null ? { startedAt: startedAt.getTime() } : {}),
    ...(finishedAt !== null ? { finishedAt: finishedAt.getTime() } : {}),
    ...(lastTriggerAt !== null
      ? { lastTriggerAt: lastTriggerAt.getTime() }
      : {}),
    totalTokens: counterNumber(totalTokens),
    accountedTokens: counterNumber(accountedTokens),
    ...(row.checkpoint
      ? {
          runtime: {
            version: 4,
            character: { conversation: {} },
            execution: row.checkpoint
              .execution as unknown as RuntimeState['execution'],
          } as RuntimeState,
        }
      : {}),
  } as StoredRun;
}

export async function saveRun(
  tx: Prisma.TransactionClient,
  next: SavedRun,
  previous?: SavedRun,
) {
  if (
    !previous ||
    next.position !== previous.position ||
    next.serialized !== previous.serialized
  ) {
    const run = JSON.parse(next.serialized) as StoredRun;
    const data = {
      position: next.position,
      planId: run.planId ?? null,
      planRevision: run.planRevision ?? null,
      characterId: run.characterId ?? null,
      characterName: run.characterName ?? null,
      source: run.source,
      status: run.status,
      reason: run.reason,
      scheduledAt: timestamp(run.scheduledAt),
      startedAt: run.startedAt == null ? null : timestamp(run.startedAt),
      finishedAt: run.finishedAt == null ? null : timestamp(run.finishedAt),
      eventId: run.eventId ?? null,
      coalescedTriggers: run.coalescedTriggers ?? null,
      lastTriggerAt:
        run.lastTriggerAt == null ? null : timestamp(run.lastTriggerAt),
      snapshot: taskJson(run.snapshot),
      task: databaseJson(run.task == null ? null : taskJson(run.task)),
      totalTokens: counter(run.totalTokens),
      accountedTokens: counter(run.accountedTokens),
      logs: taskJson(run.logs),
      actions: databaseJson(run.actions == null ? null : taskJson(run.actions)),
      requestId: run.requestId ?? null,
      lastBatch: run.lastBatch ?? null,
      requiresReassignment: run.requiresReassignment ?? null,
    };
    await tx.agentRun.upsert({
      where: { id: next.id },
      create: { id: next.id, ...data },
      update: data,
    });
  }
  if (stableJson(next.checkpoint) === stableJson(previous?.checkpoint)) return;
  if (next.checkpoint) {
    await tx.agentRunCheckpoint.upsert({
      where: { runId: next.id },
      create: { runId: next.id, ...next.checkpoint },
      update: next.checkpoint,
    });
  } else {
    await tx.agentRunCheckpoint.delete({ where: { runId: next.id } });
  }
}
