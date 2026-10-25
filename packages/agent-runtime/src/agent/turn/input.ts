import type { ChatData, WorldEvent } from '@voxel/shared';
import type { AgentConfig } from '../../contracts';
import type { DecisionContext } from '../../contracts/observation';
import type { AgentRunState, CharacterEvent } from '../../contracts/state';
import { NO_ACTIVITY_HINT } from '../prompt/system';
import { turnInput } from '../prompt/view';
import { isEndedTask } from '../task/state';

/**
 * Builds the serialized JSON input sent to the model for each decision turn.
 *
 * A human-message turn sees only the current activity headline, so a private
 * task never leaks into a public conversation. A task turn sees every effect.
 */
export function buildDecisionPayload(o: {
  config: AgentConfig;
  message?: WorldEvent;
  prepared: DecisionContext;
  memory: AgentRunState;
  event?: CharacterEvent;
}): string {
  const visible = o.prepared.context.task;
  const observation = o.message
    ? { ...o.prepared.observation, blocks: [] }
    : o.prepared.observation;
  return JSON.stringify(
    {
      ...turnInput(
        o.config,
        observation,
        turnContext(o.message, o.prepared, visible),
        visible ? o.memory : undefined,
      ),
      activityState: visible?.status ?? 'none',
      nextStep:
        o.message && isEndedTask(visible) ? NO_ACTIVITY_HINT : undefined,
      currentRequest: currentRequest(o.message),
      event: eventSummary(o.event),
      activeAction: visible ? o.memory.effects.activeAction : undefined,
    },
    (key, value) => (key === 'batchId' ? undefined : value),
  );
}

/** A message turn only sees the activity headline; a task turn sees every effect. */
function turnContext(
  message: WorldEvent | undefined,
  prepared: DecisionContext,
  visible: DecisionContext['context']['task'],
): unknown {
  if (!message) return prepared.context;
  return {
    task:
      visible && !isEndedTask(visible)
        ? {
            goal: visible.goal,
            status: visible.status,
            summary: visible.summary,
            calls: visible.calls,
            tokens: visible.tokens,
          }
        : undefined,
  };
}

function currentRequest(message?: WorldEvent) {
  if (!message) return undefined;
  return { actor: message.actor, text: (message.data as ChatData).text };
}

function eventSummary(event?: CharacterEvent) {
  return event
    ? { kind: event.kind, id: event.id, detail: event.detail }
    : { kind: 'condition_changed' };
}
