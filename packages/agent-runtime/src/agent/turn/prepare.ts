import type { AICharacterTask, ChatData, WorldEvent } from '@voxel/shared';
import type { DecisionContext, Observation } from '../../contracts/observation';
import type { AgentRunState } from '../../contracts/state';
import { worldSignature } from '../../world/observe/extract';
import type { AgentSession } from '../../world/session/port';
import { reconcilePendingEffects, reconcileUnfinishedBuild } from './reconcile';

/**
 * Observes the world, skips a wait that did not change, reconciles outstanding
 * world writes, and returns the audience-filtered context for one decision.
 */
export async function prepareDecision(
  session: Pick<AgentSession, 'observe'>,
  memory: AgentRunState,
  signal: AbortSignal,
  addressed?: WorldEvent,
): Promise<DecisionContext | undefined> {
  const task = memory.task.current;
  const observation = await session.observe();
  signal.throwIfAborted();
  if (waitStillUnchanged(addressed, task, observation, memory))
    return undefined;
  reconcileUnfinishedBuild(memory, observation);
  reconcilePendingEffects(memory, observation);
  return buildDecisionContext(memory, task, observation, addressed);
}

/** A waiting task whose watched condition did not change needs no model request. */
function waitStillUnchanged(
  addressed: WorldEvent | undefined,
  task: AICharacterTask | undefined,
  observation: Observation,
  memory: AgentRunState,
): boolean {
  return (
    !addressed &&
    task?.status === 'waiting' &&
    worldSignature(observation, task.waitFor) === memory.health.waitSignature
  );
}

/** Everything one decision may see, filtered by the audience that triggered it. */
function buildDecisionContext(
  memory: AgentRunState,
  task: AICharacterTask | undefined,
  observation: Observation,
  addressed?: WorldEvent,
): DecisionContext {
  const privateTo = privateAudience(addressed);
  const visibleTask = taskVisibleTo(task, addressed, privateTo);
  return {
    task,
    addressed,
    observation: {
      ...observation,
      attention: addressed,
      events: addressed ? [addressed] : [],
    },
    visibleTask,
    privateTo,
    context: {
      task: visibleTask,
      // Conversation and task audiences are independent: a public question never
      // sees a private task, and that task's effects stay hidden with it.
      previous: visibleTask ? memory.effects.previous : undefined,
      pendingEffects: visibleTask ? memory.effects.pendingEffects : undefined,
      follow: visibleTask ? memory.effects.follow : undefined,
      unfinishedBuild: visibleTask ? memory.effects.unfinishedBuild : undefined,
      decisionError: visibleTask ? memory.health.decisionError : undefined,
      trigger: decisionTrigger(addressed, task),
    },
  };
}

/** Private and nearby scopes answer one actor; every other scope is public. */
function privateAudience(addressed?: WorldEvent): string | undefined {
  if (!addressed) return undefined;
  const message = addressed.data as ChatData | undefined;
  if (!message || !['private', 'nearby'].includes(message.scope))
    return undefined;
  return addressed.actor;
}

/** A private task is only visible to its owner or on an unattended task turn. */
function taskVisibleTo(
  task: AICharacterTask | undefined,
  addressed: WorldEvent | undefined,
  privateTo: string | undefined,
): AICharacterTask | undefined {
  if (!task) return undefined;
  if (!task.privateTo) return task;
  return !addressed || task.privateTo === privateTo ? task : undefined;
}

/** Why the model is being asked now; unchanged waits are filtered out earlier. */
function decisionTrigger(
  addressed: WorldEvent | undefined,
  task: AICharacterTask | undefined,
): DecisionContext['context']['trigger'] {
  if (addressed) return 'message';
  return task?.status === 'waiting' ? 'condition_changed' : 'task';
}
