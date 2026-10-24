import { aiCharacterPermissions } from '@voxel/shared';
import type { AgentConfig } from '../../contracts/config';
import type { Observation } from '../../contracts/observation';
import { worldView } from '../../world/observe/extract';
import type { AgentRunState } from '../../contracts/state';

export function formatTurnInput(
  config: AgentConfig,
  observation: Observation,
  context: unknown,
  memory?: AgentRunState,
) {
  return JSON.stringify(
    {
      character: {
        roleDescription: config.roleDescription ?? '',
        permissions: aiCharacterPermissions(config),
        skills: config.skills ?? [],
      },
      trigger: observation.attention ? 'NEW HUMAN MESSAGE' : 'AUTOMATIC TASK',
      observation: worldView(observation),
      previous: context,
      recovery:
        memory?.checkpoint.unknownEffect ||
        memory?.checkpoint.pi?.inFlight?.state === 'unknown'
          ? {
              ...(memory.checkpoint.unknownEffect ??
                memory.checkpoint.pi?.inFlight),
              instruction:
                'Previous tool effect is unknown; inspect before replanning. Never automatically resend chat or movement.',
            }
          : undefined,
    },
    (key, value) => (key === 'batchId' ? undefined : value),
  );
}
