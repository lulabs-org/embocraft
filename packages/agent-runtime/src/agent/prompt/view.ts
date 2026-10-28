import {
  aiCharacterPermissions,
  type ChatData,
  type WorldEvent,
} from '@voxel/shared';
import type { AgentConfig } from '../../contracts/config';
import type { DecisionContext, Observation } from '../../contracts/observation';
import type { CharacterEvent, RuntimeState } from '../../contracts/state';
import { worldView } from '../../world/observe/extract';
import { isEndedTask } from '../task/state';

const RECOVERY_INSTRUCTION =
  'Previous tool effect is unknown; inspect before replanning. Never automatically resend chat or movement.';

/** One-step guidance when a human asks for world work while no activity exists. */
export const NO_ACTIVITY_HINT =
  'No activity exists. To perform requested world actions, first call start_task(goal), then the world tool. For questions use the native chat tool.';

/** The structured model view; callers add their turn-specific fields before serializing. */
export function turnInput(
  config: AgentConfig,
  observation: Observation,
  context: unknown,
  memory?: RuntimeState,
) {
  const inFlight = memory?.execution.checkpoint.pi?.inFlight;
  const unknown =
    memory?.execution.checkpoint.unknownEffect ??
    (inFlight?.state === 'unknown' ? inFlight : undefined);

  return {
    character: {
      roleDescription: config.roleDescription ?? '',
      permissions: aiCharacterPermissions(config),
      skills: config.skills ?? [],
    },
    trigger: observation.attention ? 'NEW HUMAN MESSAGE' : 'AUTOMATIC TASK',
    observation: worldView(observation),
    previous: context,
    recovery: unknown
      ? { ...unknown, instruction: RECOVERY_INSTRUCTION }
      : undefined,
  };
}

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
  memory: RuntimeState;
  event?: CharacterEvent;
}): string {
  const { config, message, prepared, memory, event } = o;
  const visible = prepared.context.task;
  const activeTask = visible && !isEndedTask(visible) ? visible : undefined;
  const observation = message
    ? { ...prepared.observation, blocks: [] }
    : prepared.observation;
  const previous = message
    ? {
        task: activeTask && {
          goal: activeTask.goal,
          status: activeTask.status,
          summary: activeTask.summary,
          calls: activeTask.calls,
          tokens: activeTask.tokens,
        },
      }
    : prepared.context;

  return JSON.stringify(
    {
      ...turnInput(config, observation, previous, visible ? memory : undefined),
      activityState: visible?.status ?? 'none',
      nextStep: message && !activeTask ? NO_ACTIVITY_HINT : undefined,
      currentRequest: message && {
        actor: message.actor,
        text: (message.data as ChatData).text,
      },
      event: event
        ? { kind: event.kind, id: event.id, detail: event.detail }
        : { kind: 'condition_changed' },
      activeAction: visible ? memory.execution.effects.activeAction : undefined,
    },
    (key, value) => (key === 'batchId' ? undefined : value),
  );
}
