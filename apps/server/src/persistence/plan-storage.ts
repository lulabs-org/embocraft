import type { AgentPlan, Prisma } from '@prisma/client';
import type { TaskPlan } from '@voxel/shared';
import { stableJson } from './stable-json';
import {
  counter,
  counterNumber,
  taskJson,
  timestamp,
  withoutNullFields,
} from './task-storage-values';

export type SavedPlan = { id: string; position: number; serialized: string };

export function capturePlan(plan: TaskPlan, position: number): SavedPlan {
  // latestRun is assembled by the query/view layer, never an authoritative copy.
  const { latestRun: _latestRun, ...record } = plan;
  return { id: plan.id, position, serialized: stableJson(record) };
}

export function restorePlan(row: AgentPlan): TaskPlan {
  const {
    position: _position,
    scheduleKind,
    scheduleSpec,
    createdAt,
    updatedAt,
    nextRunAt,
    totalTokenBudget,
    spentTokens,
    ...record
  } = row;
  return {
    ...withoutNullFields(record),
    timing: { ...(scheduleSpec as object), kind: scheduleKind },
    createdAt: createdAt.getTime(),
    updatedAt: updatedAt.getTime(),
    ...(nextRunAt !== null ? { nextRunAt: nextRunAt.getTime() } : {}),
    totalTokenBudget: counterNumber(totalTokenBudget),
    spentTokens: counterNumber(spentTokens),
  } as TaskPlan;
}

export async function savePlan(
  tx: Prisma.TransactionClient,
  next: SavedPlan,
  previous?: SavedPlan,
) {
  if (
    previous &&
    next.position === previous.position &&
    next.serialized === previous.serialized
  )
    return;
  const plan = JSON.parse(next.serialized) as TaskPlan;
  const { kind, ...scheduleSpec } = plan.timing;
  const data = {
    position: next.position,
    characterId: plan.characterId ?? null,
    characterName: plan.characterName ?? null,
    revision: plan.revision ?? null,
    imported: plan.imported ?? null,
    name: plan.name,
    goal: plan.goal,
    scheduleKind: kind,
    scheduleSpec: taskJson(scheduleSpec),
    timeZone: plan.timeZone,
    limits: taskJson(plan.limits),
    limitsMode: plan.limitsMode ?? null,
    totalTokenBudgetEnabled: plan.totalTokenBudgetEnabled ?? null,
    totalTokenBudget: counter(plan.totalTokenBudget),
    state: plan.state,
    reason: plan.reason,
    nextRunAt: plan.nextRunAt == null ? null : timestamp(plan.nextRunAt),
    spentTokens: counter(plan.spentTokens),
    createdAt: timestamp(plan.createdAt),
    updatedAt: timestamp(plan.updatedAt),
  };
  await tx.agentPlan.upsert({
    where: { id: next.id },
    create: { id: next.id, ...data },
    update: data,
  });
}
