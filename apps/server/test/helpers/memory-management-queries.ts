import { runtimeView } from '@voxel/agent-runtime';
import {
  AI_CHARACTER_LOG_LIMIT,
  type AICharacterView,
  type TaskPlanSummary,
} from '@voxel/shared';
import { AppError } from '../../src/core/errors/app-error';
import type { ManagementArchive } from '../../src/persistence/management-archive';
import type { CharacterReadPort } from '../../src/modules/ai-characters/ports';
import type { TaskQueryPort } from '../../src/modules/tasks/ports';
import type { PlanQueryFilter } from '../../src/modules/tasks/domain/types';
import { TaskPlanService } from '../../src/modules/tasks/services/plan.service';

type Read = () => Promise<ManagementArchive | undefined>;

/** Test-only implementations; production never falls back to loading archives for queries. */
export class MemoryCharacterReads implements CharacterReadPort {
  constructor(
    private readonly read: Read,
    private readonly providerName: (id: string) => string = (id) => id,
  ) {}
  async record(id: string) {
    const record = (await this.read())?.characters.find(
      (record) => record.id === id,
    );
    if (!record) throw new AppError('Agent 不存在。', 404);
    return {
      ...record,
      logEntries: record.logEntries.slice(-AI_CHARACTER_LOG_LIMIT),
    };
  }
  async view(id: string) {
    const view = (await this.views()).find((view) => view.id === id);
    if (!view) throw new AppError('Agent 不存在。', 404);
    return view;
  }
  async views(): Promise<AICharacterView[]> {
    const archive = await this.read();
    return (archive?.characters ?? [])
      .slice()
      .reverse()
      .map((record) => {
        const { runtime, currentRunId, ...view } = record;
        const state = runtime ? runtimeView(runtime) : undefined;
        const run = archive!.runs.find((run) => run.id === currentRunId);
        return {
          ...view,
          providerName: this.providerName(view.providerId),
          logEntries: view.logEntries.slice(-AI_CHARACTER_LOG_LIMIT),
          task: state?.task,
          usage: state?.usage,
          lastResponse: state?.lastResponse,
          taskRequiresReassignment: state?.requiresReassignment,
          taskExecution: run
            ? {
                runId: run.id,
                limits: run.snapshot.limits,
                source: run.source,
                action: state?.action,
              }
            : undefined,
          queuedTasks: archive!.runs
            .filter(
              (run) => run.characterId === view.id && run.status === 'queued',
            )
            .map((run) => ({
              id: run.id,
              goal: run.snapshot.goal,
              scheduledAt: run.scheduledAt,
              coalescedTriggers: run.coalescedTriggers ?? 0,
            })),
        };
      });
  }
  async hasProviderReference(id: string) {
    return !!(await this.read())?.characters.some(
      (record) => record.providerId === id,
    );
  }
  async hasVoiceServiceReference(id: string) {
    return !!(await this.read())?.characters.some(
      (record) => record.voiceServiceId === id,
    );
  }
}

export class MemoryTaskQueries implements TaskQueryPort {
  constructor(private readonly read: Read) {}
  private async state() {
    const archive = await this.read();
    const plans = new TaskPlanService();
    if (archive)
      Object.assign(plans, {
        plans: archive.plans,
        runs: archive.runs,
        requests: archive.requests,
      });
    const characters = new Map(
      archive?.characters.map((record) => [record.id, record]),
    );
    const identity = (id?: string) => {
      const state = id ? characters.get(id)?.runtime : undefined;
      return state ? (runtimeView(state).identity ?? null) : null;
    };
    return { plans, characters, identity };
  }
  async plans(id?: string, requireCharacter = false) {
    const { plans, characters, identity } = await this.state();
    if (requireCharacter && !characters.has(id!))
      throw new AppError('Agent 不存在。', 404);
    return plans
      .views(id)
      .map((value) => ({
        value,
        characterName: value.characterId
          ? characters.get(value.characterId)?.name
          : undefined,
        taskIdentity: identity(value.characterId),
      }));
  }
  async plan(id: string) {
    const result = (await this.plans()).find(({ value }) => value.id === id);
    if (!result) throw new AppError('计划不存在。', 404);
    return result;
  }
  async planPage(p: PlanQueryFilter) {
    const { plans, characters } = await this.state();
    const all = plans.plans
      .filter(
        (plan) =>
          (!p.characterId || plan.characterId === p.characterId) &&
          (!p.search ||
            plan.name
              .toLocaleLowerCase()
              .includes(p.search.toLocaleLowerCase())) &&
          (p.state
            ? p.state === 'unassigned'
              ? !plan.characterId && plan.state === 'paused'
              : plan.state === p.state
            : plan.state !== 'archived') &&
          (!p.timing || plan.timing.kind === p.timing),
      )
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const offset = p.offset ?? 0;
    const items: TaskPlanSummary[] = all
      .slice(offset, offset + 20)
      .map((plan) => ({
        id: plan.id,
        name: plan.name,
        timing: plan.timing,
        timeZone: plan.timeZone,
        state: plan.state,
        characterId: plan.characterId,
        characterName: plan.characterId
          ? (characters.get(plan.characterId)?.name ?? plan.characterName)
          : plan.characterName,
      }));
    return {
      items,
      total: all.length,
      nextOffset: offset + 20 < all.length ? offset + 20 : undefined,
    };
  }
  async runs(
    planId: string,
    offset = 0,
    id?: string,
    requireCharacter = false,
  ) {
    const { plans, characters, identity } = await this.state();
    if (requireCharacter && !characters.has(id!))
      throw new AppError('Agent 不存在。', 404);
    if (id) plans.assertBinding(planId, id);
    const page = plans.history(planId, offset);
    const wrap = (value: (typeof page.items)[number]) => ({
      value,
      taskIdentity: identity(value.characterId),
    });
    return {
      ...page,
      items: page.items.map(wrap),
      active: page.active.map(wrap),
    };
  }
}
