import type { ChatData, WorldEvent } from '@voxel/shared';
import type { AgentConfig } from '../../contracts';
import { formatTurnInput } from '../prompt/view';
import type { DecisionContext } from '../../contracts/observation';
import type { AgentRunState, CharacterEvent } from '../../contracts/state';

/**
 * Builds the serialized JSON input sent to the model for each decision turn.
 * Formats the current observation, active task context, current event, and instructions.
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
  const context = o.message
    ? {
        task:
          visible && !['completed', 'cancelled'].includes(visible.status)
            ? {
                goal: visible.goal,
                status: visible.status,
                summary: visible.summary,
                calls: visible.calls,
                tokens: visible.tokens,
              }
            : undefined,
      }
    : o.prepared.context;

  const rawInput = JSON.parse(
    formatTurnInput(
      o.config,
      observation,
      context,
      visible ? o.memory : undefined,
    ),
  );

  return JSON.stringify({
    ...rawInput,
    activityState: visible?.status ?? 'none',
    nextStep:
      (!visible || ['completed', 'cancelled'].includes(visible.status)) &&
      o.message
        ? 'No activity exists. To perform requested world actions, first call start_task(goal), then the world tool. For questions use the native chat tool.'
        : undefined,
    currentRequest: o.message
      ? { actor: o.message.actor, text: (o.message.data as ChatData).text }
      : undefined,
    event: o.event
      ? { kind: o.event.kind, id: o.event.id, detail: o.event.detail }
      : { kind: 'condition_changed' },
    activeAction: visible ? o.memory.effects.activeAction : undefined,
  });
}
