/** Test DSL adapter: exercise task policy and world execution without a provider. */
import { aiCharacterPermissions } from '@voxel/shared';
import type { AICharacterTask } from '@voxel/shared';
import type {
  AgentConfig,
  AgentAction,
} from '../../packages/agent-runtime/src/contracts';
import type { AgentSession } from '../../packages/agent-runtime/src/world/session/port';
import type { AgentRunState } from '../../packages/agent-runtime/src/contracts/state';
import type { RequestBudget } from '../../packages/agent-runtime/src/agent/task/budget';
import { checkBudgetCap } from '../../packages/agent-runtime/src/agent/task/budget';
import type { DecisionContext } from '../../packages/agent-runtime/src/contracts/observation';
import { worldSignature } from '../../packages/agent-runtime/src/world/observe/extract';
import {
  TaskService,
  type TaskCommand,
} from '../../packages/agent-runtime/src/agent/task/service';
import { executeTaskActions } from '../../packages/agent-runtime/src/agent/action/executor';
import { executeBatch } from '../../packages/agent-runtime/src/world/actions/batch';
import type { AgentAttention } from '../../packages/agent-runtime/src/world/observe/attention';
import { AgentRuntimeError } from '../../packages/agent-runtime/src/contracts/errors';
import { parseDecision } from './decision-decision';
import type { AgentDecision } from './decision-contracts';

export async function applyTaskDecision(
  session: AgentSession,
  input: AgentDecision,
  prepared: DecisionContext,
  config: AgentConfig,
  signal: AbortSignal,
  memory: AgentRunState,
  budget: RequestBudget,
  attention?: AgentAttention,
  log: (message: string) => void = () => {},
  checkpoint: () => void | Promise<void> = () => {},
  hooks?: {
    beforeNewTask?: (
      task: AICharacterTask,
      previous: AgentRunState,
    ) => Promise<void>;
  },
) {
  let parsed;
  try {
    parsed = parseDecision(input, aiCharacterPermissions(config));
  } catch (error) {
    throw new AgentRuntimeError((error as Error).message);
  }
  let { actions } = parsed;
  const { task: d } = parsed;
  const { addressed } = prepared;
  const service = new TaskService(memory);
  const save = async () => {
    await checkpoint();
  };
  const notify = async (text: string) => {
    if (addressed && aiCharacterPermissions(config).chat)
      await session.request('chat', {
        text: text.slice(0, 240),
        scope: 'private',
        recipients: [addressed.actor],
      });
  };
  if (
    !addressed &&
    ['task', 'update'].includes(d.intent) &&
    (!d.goal || d.goal === memory.task.current?.goal)
  )
    d.intent = 'continue';
  if (
    (!addressed && d.intent !== 'continue') ||
    (addressed && d.intent === 'continue')
  )
    throw new AgentRuntimeError(
      '新消息必须区分意图，自动推进必须使用 intent=continue。',
    );
  if (d.intent === 'reply') {
    const { batch } = await executeBatch(
      session,
      actions,
      prepared.observation,
      aiCharacterPermissions(config),
      signal,
      {
        checkpoint: async (b) => {
          memory.conversation.lastReply = b;
          await save();
        },
      },
    );
    memory.conversation.lastReply = batch;
    if (
      !batch.results.some(
        (r) => r.action.type === 'chat' && r.status === 'succeeded',
      )
    )
      await notify(d.summary);
    memory.health.lastResponse = d.summary;
    return;
  }
  if (addressed) {
    const type =
      d.intent === 'task'
        ? 'start'
        : d.intent === 'update'
          ? 'revise'
          : d.intent;
    try {
      await service.commit(
        { type, goal: d.goal } as TaskCommand,
        { kind: 'player', message: addressed },
        config,
        save,
        budget,
        hooks?.beforeNewTask,
      );
    } catch (error) {
      if (memory.task.current && checkBudgetCap(memory.task.current, config)) {
        memory.task.current.status = 'budget';
        memory.task.current.reason = checkBudgetCap(
          memory.task.current,
          config,
        )!;
        await notify(memory.task.current.reason);
        return;
      }
      throw error;
    }
    if (type === 'pause' || type === 'cancel') {
      await notify(memory.task.current!.reason);
      return;
    }
  }
  if (
    d.status === 'completed' &&
    memory.effects.unfinishedBuild &&
    actions.every((a) => ['chat', 'wait'].includes(a.type))
  ) {
    d.status = 'blocked';
    d.summary = '仍有未确认完成的建造方块。';
    actions = [{ type: 'chat', text: d.summary }];
  }
  const lease = service.lease();
  const outcome = await executeTaskActions(
    session,
    actions,
    prepared.observation,
    config,
    signal,
    memory,
    budget,
    lease,
    save,
    attention,
    log,
  );
  const mutated = outcome.batch.results.some(
    (r) =>
      r.status !== 'pending' &&
      ['edit', 'build', 'house', 'move', 'goto', 'follow'].includes(
        r.action.type,
      ),
  );
  const task = memory.task.current!;
  task.summary = d.summary;
  if (actions.some((a) => a.type === 'move') && d.status === 'waiting')
    d.status = 'running';
  if (outcome.batch.ok && !(mutated && d.status === 'completed')) {
    if (d.status !== 'running') {
      try {
        service.finish(
          lease,
          d.status === 'waiting'
            ? {
                status: 'waiting',
                reason: d.summary,
                waitFor: d.waitFor!,
                signature: worldSignature(outcome.observation, d.waitFor),
              }
            : { status: d.status, reason: d.summary },
        );
      } catch {
        task.status = 'blocked';
        task.reason = '仍有未完成或未确认的建造方块。';
      }
    }
  } else task.status = 'running';
  const position = JSON.stringify([
    outcome.observation.self.x,
    outcome.observation.self.y,
    outcome.observation.self.z,
    worldSignature(outcome.observation, 'world'),
  ]);
  if (outcome.batch.stopReason !== 'message') {
    memory.health.noProgress =
      !outcome.batch.ok || position === memory.health.lastProgress
        ? (memory.health.noProgress ?? 0) + 1
        : 0;
    memory.health.lastProgress = position;
    if (memory.health.noProgress >= 3 && task.status === 'running') {
      task.status = 'blocked';
      task.reason = '连续三次失败或没有实际进展，已停止自动重试。';
    }
  }
  if (addressed && !actions.some((a: AgentAction) => a.type === 'chat'))
    await notify(`收到。${task.summary}`);
}
