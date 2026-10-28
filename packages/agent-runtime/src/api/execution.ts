import type { AICharacterTask, AICharacterUsage } from '@voxel/shared';
import type { AgentConfig } from '../contracts/config';
import {
  emptyState,
  snapshotState,
  type AgentRunState,
} from '../contracts/state';
import type { TaskAuthority, TaskCommand, TaskLease } from '../contracts/task';
import { TaskService } from '../agent/task/service';
import { isActiveTask, isEndedTask, newTask } from '../agent/task/state';
import { recordEvent } from '../agent/task/inbox';
import {
  recoverCharacter,
  recoverHistoricalExecution,
} from '../agent/state/recovery';
import { restoreState } from '../persistence/migrate';
import {
  resumeTaskState,
  rollbackTaskState,
  startScheduledTaskState,
} from './state';

export type RuntimeView = {
  task?: AICharacterTask;
  identity?: TaskLease;
  usage?: AICharacterUsage;
  action?: { id: string; name: string; status: string };
  lastResponse?: string;
  requiresReassignment: boolean;
  audienceExpired?: boolean;
  following: boolean;
  active: boolean;
  occupied: boolean;
};

export type RuntimePlanInput = {
  runId: string;
  planId: string;
  characterId: string;
  at: number;
  goal: string;
  eventId?: string;
};

type ActionBatchRecord = {
  batchId?: string;
  results?: {
    startedAt?: number;
    action?: { type?: string };
    status?: string;
    result?: unknown;
  }[];
};

export function runtimeView(state: AgentRunState): RuntimeView {
  const action = state.effects.activeAction;
  return structuredClone({
    task: state.task.current,
    identity: state.task.identity,
    usage: state.task.usage,
    action: action
      ? { id: action.id, name: action.name, status: action.status }
      : undefined,
    lastResponse: state.health.lastResponse,
    requiresReassignment: !!state.conversation.audienceExpired,
    audienceExpired: state.conversation.audienceExpired,
    following: !!state.effects.follow,
    active: isActiveTask(state.task.current),
    occupied: !isEndedTask(state.task.current),
  });
}

/** State operations shared by online characters, CLI hosts and offline archives. */
export class RuntimeExecution {
  private memory: AgentRunState;
  private epoch = 0;

  constructor(state: AgentRunState = emptyState()) {
    this.memory = state;
  }

  protected assertIdle(): void {}

  /** Legacy compatibility only. Production hosts read view()/snapshot() instead. */
  get state(): AgentRunState {
    return this.memory;
  }
  get stateEpoch(): number {
    return this.epoch;
  }

  /** Legacy root replacement; only call after the host has stopped execution. */
  replaceState(state: AgentRunState) {
    this.assertIdle();
    this.memory = state;
    this.epoch++;
  }

  restore(raw: unknown) {
    this.replaceState(restoreState(raw));
  }
  rollback(snapshot: AgentRunState, replace = false) {
    if (replace) this.replaceState(snapshot);
    else rollbackTaskState(this.memory, snapshot);
  }
  snapshot(): AgentRunState {
    return structuredClone(this.memory);
  }
  archive(): AgentRunState {
    return snapshotState(this.memory);
  }

  view(): RuntimeView {
    return runtimeView(this.memory);
  }

  /** Immutable ledger projection; archive internals remain opaque to the host. */
  executionRecord() {
    if (this.memory.task.current) this.lease();
    return {
      task: structuredClone(this.memory.task.current),
      calls: this.memory.task.usage?.calls,
      batch: structuredClone(this.memory.effects.previous) as
        | ActionBatchRecord
        | undefined,
      runtime: this.archive(),
    };
  }

  lease(): TaskLease {
    return new TaskService(this.memory).lease();
  }
  authorize(authority: TaskAuthority, lease?: TaskLease) {
    const service = new TaskService(this.memory);
    if (lease) service.assertCurrent(lease);
    service.authorize(authority);
  }

  /** Synchronous staging for a host's joint runtime/ledger persistence transaction. */
  stageControl(
    command: TaskCommand,
    authority: TaskAuthority,
    config: AgentConfig,
    reason?: string,
  ) {
    this.assertIdle();
    const task = new TaskService(this.memory).command(
      command,
      authority,
      config,
    );
    if (command.type === 'cancel') delete this.memory.effects.follow;
    if (reason !== undefined) task.reason = reason;
    return structuredClone(task);
  }

  /** CLI's initial goal retains the original default-task semantics. */
  ensureTask(goal: string) {
    this.memory.task.current ??= newTask(goal);
  }

  queuePlan(input: RuntimePlanInput & { revision: number }): string {
    const id = `plan:${input.planId}:${input.revision}:${input.at}`;
    recordEvent(this.memory, {
      id,
      kind: 'plan',
      state: 'pending',
      at: input.at,
      audience: 'public',
      characterId: input.characterId,
      planId: input.planId,
      runId: input.runId,
      detail: input.goal,
    });
    return id;
  }

  startScheduled(input: RuntimePlanInput) {
    const task = newTask(input.goal);
    const initial = { ...emptyState(), task: { current: task } };
    this.replaceState(startScheduledTaskState(this.memory, task));
    const lease = this.lease();
    const event = recordEvent(this.memory, {
      id: input.eventId ?? `run:${input.runId}`,
      kind: 'plan',
      state: 'pending',
      at: input.at,
      audience: 'public',
      runId: input.runId,
      detail: input.goal,
    });
    Object.assign(event, {
      taskId: lease.id,
      revision: lease.revision,
      characterId: input.characterId,
      planId: input.planId,
    });
    return structuredClone({ task, runtime: initial });
  }

  resumeExecution(archived: AgentRunState, config: AgentConfig) {
    this.replaceState(resumeTaskState(this.memory, archived));
    this.stageControl({ type: 'resume' }, { kind: 'operator' }, config);
  }

  recordRunControl(input: {
    runId: string;
    characterId: string;
    operation: 'pause' | 'cancel' | 'resume';
    actor?: string;
    queued?: boolean;
  }) {
    const lease = input.queued ? undefined : this.lease();
    recordEvent(this.memory, {
      id: input.queued
        ? `control:${input.runId}:cancel`
        : `control:${input.runId}:${lease!.revision}:${input.operation}`,
      kind: 'control',
      state: input.operation === 'resume' ? 'pending' : 'done',
      at: Date.now(),
      audience: input.queued
        ? 'public'
        : (this.memory.task.current?.privateTo ?? 'public'),
      ...(input.queued
        ? {}
        : { actor: input.actor, taskId: lease!.id, revision: lease!.revision }),
      characterId: input.characterId,
      runId: input.runId,
      detail: input.queued
        ? '取消待执行项'
        : input.operation === 'resume'
          ? '人工继续执行，保留原进度和用量。'
          : input.operation,
    });
  }

  reconcilePlanEvents(
    resolve: (runId?: string) => { ended: boolean; reason: string } | undefined,
  ) {
    for (const event of this.memory.inbox?.events ?? []) {
      if (event.kind !== 'plan' || event.state !== 'pending') continue;
      const run = resolve(event.runId);
      if (!run || run.ended) {
        event.state = 'done';
        event.detail = run?.reason ?? '排队提交未完成。';
      }
    }
  }

  pauseForHost(config: AgentConfig, reason: string) {
    if (!isEndedTask(this.memory.task.current))
      this.stageControl(
        { type: 'pause' },
        { kind: 'operator' },
        config,
        reason,
      );
  }
  joined() {
    const task = this.memory.task.current;
    if (task && ['running', 'waiting', 'paused'].includes(task.status)) {
      task.status = 'paused';
      task.reason = '已加入世界待命，任务进度保留。';
    }
  }
  offline(config: AgentConfig) {
    if (isActiveTask(this.memory.task.current))
      this.pauseForHost(config, '角色已离开世界，任务进度已保留。');
  }
  modelChanged(config: AgentConfig) {
    this.pauseForHost(config, '模型已修改，进度已保留，请确认后继续。');
    if (this.memory.checkpoint.pi?.inFlight)
      this.memory.checkpoint.unknownEffect = {
        ...this.memory.checkpoint.pi.inFlight,
        state: 'unknown',
      };
    delete this.memory.checkpoint.pi;
  }
  recoverAfterRestart() {
    this.assertIdle();
    recoverCharacter(this.memory);
  }
  recoverHistory(options: { unfinished: boolean; running: boolean }) {
    this.assertIdle();
    return recoverHistoricalExecution(this.memory, options);
  }
}
