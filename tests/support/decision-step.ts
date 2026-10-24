// Deterministic decision adapter for existing domain-policy fixtures. No production inference.
import type { Planner } from './decision-fixture';
import { aiCharacterPermissions } from '@voxel/shared';
import type { AICharacterTask } from '@voxel/shared';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentConfig } from '../../packages/agent-runtime/src/contracts';
import type { AgentSession } from '../../packages/agent-runtime/src/world/session/port';
import type { AgentAttention } from '../../packages/agent-runtime/src/world/observe/attention';
import type { AgentRunState } from '../../packages/agent-runtime/src/contracts/state';
import { AgentRuntimeError } from '../../packages/agent-runtime/src/contracts/errors';
import { RequestBudget } from '../../packages/agent-runtime/src/agent/task/budget';

import { prepareDecision } from '../../packages/agent-runtime/src/agent/turn/prepare';
import { checkBudgetCap } from '../../packages/agent-runtime/src/agent/task/budget';
import { applyTaskDecision } from './decision-apply';
export { worldSignature } from '../../packages/agent-runtime/src/world/observe/extract';
/** Empty polls and unchanged waits cost no tokens; planners count actual requests. */
export async function runTaskStep(
  session: Pick<AgentSession, 'observe' | 'move' | 'request'>,
  planner: Planner,
  config: AgentConfig,
  signal: AbortSignal,
  memory: AgentRunState,
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
  const addressed = attention?.take();
  const task = memory.task.current;
  if (!addressed && !['running', 'waiting'].includes(task?.status ?? ''))
    return;
  if (!addressed && task) {
    const reason = checkBudgetCap(task, config);
    if (reason) {
      task.status = 'budget';
      task.reason = reason;
      log(reason);
      return;
    }
  }
  const prepared = await prepareDecision(session, memory, signal, addressed);
  if (!prepared) return;
  const { observation, context } = prepared;
  memory.task.usage ??= { calls: 0, tokens: 0, estimated: false };

  let chargedTask = !addressed ? task : undefined;
  const budget = new RequestBudget(config, memory.task.usage, chargedTask);
  const deadline = new AbortController();
  const decisionRemaining = chargedTask
    ? (config.taskTimeoutMs ?? 900000) - chargedTask.elapsedMs
    : (config.taskTimeoutMs ?? 900000);
  const decisionTimer = Number.isFinite(decisionRemaining)
    ? setTimeout(() => deadline.abort(), Math.max(1, decisionRemaining))
    : undefined;
  const decisionSignal = AbortSignal.any([signal, deadline.signal]);
  const notifySender = async (text: string) => {
    if (!addressed || signal.aborted || !aiCharacterPermissions(config).chat)
      return;
    try {
      const payload = {
        text: text.slice(0, 240),
        scope: 'private',
        recipients: [addressed.actor],
      };
      let result = await session.request('chat', payload);
      if (!result.ok && result.error === '发送过快，请稍候。') {
        await delay(350, undefined, { signal });
        result = await session.request('chat', payload);
      }
      if (!result.ok) log('消息处理回执未送达。');
    } catch {
      log('消息处理回执未送达。');
    }
  };
  const phase = '获取模型决策';
  try {
    if (!planner.managesRequests) budget.begin();
    const input = await planner.decide(
      observation,
      context,
      decisionSignal,
      budget,
    );
    await applyTaskDecision(
      session,
      input,
      prepared,
      config,
      decisionSignal,
      memory,
      budget,
      attention,
      log,
      checkpoint,
      hooks,
    );
    if (input.task.intent !== 'reply') chargedTask = memory.task.current;
  } catch (error) {
    if (signal.aborted) return;
    memory.health.failures = (memory.health.failures ?? 0) + 1;
    const reason =
      error instanceof AgentRuntimeError
        ? error.message
        : deadline.signal.aborted
          ? '本次任务决策超时，动作已停止。'
          : `${phase}时发生内部异常，已停止本次处理。`;
    memory.health.decisionError = reason;
    memory.health.lastResponse = reason;
    log(reason);
    await notifySender(`这条消息处理失败：${reason} 请稍后重试。`);
    if (task && !addressed) {
      if (
        (error instanceof AgentRuntimeError && error.fatal) ||
        memory.health.failures >= 3
      ) {
        task.status = 'blocked';
        task.reason = reason;
        throw new AgentRuntimeError('Agent 已停止自动执行：' + reason, true);
      }
    }
  } finally {
    clearTimeout(decisionTimer);
    if (!planner.managesRequests && budget.usage.calls)
      budget.finish(
        planner.lastUsage?.tokens ?? config.maxTokens,
        planner.lastUsage?.estimated ?? true,
      );
    budget.flushTime();
    if (chargedTask) {
      const reason = checkBudgetCap(chargedTask, config);
      if (reason && ['running', 'waiting'].includes(chargedTask.status)) {
        chargedTask.status = 'budget';
        chargedTask.reason = reason;
      }
    }
  }
}
