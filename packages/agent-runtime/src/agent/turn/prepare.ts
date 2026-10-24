import { key, type ChatData, type WorldEvent } from '@voxel/shared';
import type { BatchResult, Observation } from '../../contracts';
import type { DecisionContext } from '../../contracts/observation';
import type { AgentRunState } from '../../contracts/state';
import { worldSignature } from '../../world/observe/extract';
import { arrived, observedEmpty } from '../../world/observe/verify';
import type { AgentSession } from '../../world/session/port';

export async function prepareDecision(
  session: Pick<AgentSession, 'observe'>,
  memory: AgentRunState,
  signal: AbortSignal,
  addressed?: WorldEvent,
): Promise<DecisionContext | undefined> {
  const task = memory.task.current;
  const raw = await session.observe();
  signal.throwIfAborted();
  if (
    !addressed &&
    task?.status === 'waiting' &&
    worldSignature(raw, task.waitFor) === memory.health.waitSignature
  )
    return undefined;
  if (memory.effects.unfinishedBuild) {
    const observed = new Map(
      (raw.blocks ?? []).map((b) => [`${b.x},${b.y},${b.z}`, b.material]),
    );
    const remaining = memory.effects.unfinishedBuild.result.remaining.filter(
      (b) =>
        b.material !== null
          ? observed.get(key(b)) !== b.material
          : !observedEmpty(raw, b),
    );
    if (!remaining.length) memory.effects.unfinishedBuild = undefined;
    else {
      memory.effects.unfinishedBuild.result.remaining = remaining;
      memory.effects.unfinishedBuild.result.uncertain =
        memory.effects.unfinishedBuild.result.uncertain?.filter((b) =>
          remaining.some((p) => key(p) === key(b)),
        );
    }
  }
  if (memory.effects.pendingEffects) {
    const latest = memory.effects.previous as BatchResult | undefined;
    // A verified replacement destination supersedes a known navigation failure.
    // Unknown effects and failed edits still need their own reconciliation.
    const correctedArrival = latest?.results?.some(
      (r) =>
        r.action.type === 'goto' &&
        r.status === 'succeeded' &&
        r.result?.ok &&
        'status' in r.result &&
        r.result.status === 'arrived' &&
        arrived(raw, r.action),
    );
    const resolved = memory.effects.pendingEffects.results
      .filter((r) => !['pending', 'succeeded'].includes(r.status))
      .every((r) => {
        if (r.action.type === 'edit') {
          const edit = r.action;
          return edit.material === null
            ? observedEmpty(raw, edit)
            : raw.blocks.some(
                (b) => key(b) === key(edit) && b.material === edit.material,
              );
        }
        if (r.action.type === 'goto')
          return (
            arrived(raw, r.action) ||
            (r.status === 'failed' &&
              r.result &&
              'status' in r.result &&
              r.result.status === 'failed' &&
              correctedArrival)
          );
        if (r.action.type === 'follow')
          return (
            !!memory.effects.follow &&
            memory.effects.follow.taskStartedAt === task?.startedAt
          );
        if (r.action.type === 'move')
          return (
            !!r.before &&
            Math.hypot(
              raw.self.x - r.before.x,
              raw.self.y - r.before.y,
              raw.self.z - r.before.z,
            ) >= 0.05
          );
        if (r.action.type === 'build' || r.action.type === 'house')
          return !memory.effects.unfinishedBuild;
        return false;
      });
    if (resolved) {
      const unknown = memory.checkpoint.unknownEffect;
      if (
        unknown &&
        unknown.name !== 'chat' &&
        memory.effects.pendingEffects.results.some(
          (r) => r.action.type === unknown.name,
        )
      ) {
        delete memory.checkpoint.unknownEffect;
        if (memory.checkpoint.pi?.inFlight?.id === unknown.id)
          delete memory.checkpoint.pi.inFlight;
      }
      delete memory.effects.pendingEffects;
    }
  }
  const message = addressed?.data as ChatData | undefined;
  const privateTo =
    message && ['private', 'nearby'].includes(message.scope)
      ? addressed!.actor
      : undefined;
  // Conversation and task audiences are independent. A public question never sees a private task.
  const visibleTask =
    task &&
    (!task.privateTo || (addressed ? task.privateTo === privateTo : true))
      ? task
      : undefined;
  const observation: Observation = {
    ...raw,
    attention: addressed,
    events: addressed ? [addressed] : [],
  };
  const context: DecisionContext['context'] = {
    task: visibleTask,
    previous: visibleTask ? memory.effects.previous : undefined,
    pendingEffects: visibleTask ? memory.effects.pendingEffects : undefined,
    follow: visibleTask ? memory.effects.follow : undefined,
    unfinishedBuild: visibleTask ? memory.effects.unfinishedBuild : undefined,
    decisionError: visibleTask ? memory.health.decisionError : undefined,
    trigger: addressed
      ? 'message'
      : task?.status === 'waiting'
        ? 'condition_changed'
        : 'task',
  };
  return { task, addressed, observation, visibleTask, privateTo, context };
}
