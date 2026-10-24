import type { AICharacterTask } from '@voxel/shared';
import type { AgentConfig } from '../../contracts';
import type { AgentSession } from '../../world/session/port';
import type { AgentRunState } from '../../contracts/state';
import type { AgentAttention } from '../../world/observe/attention';

export type RunOptions = {
  session: AgentSession;
  config: AgentConfig;
  defaults?: AgentConfig;
  signal: AbortSignal;
  memory: AgentRunState;
  attention?: AgentAttention;
  log?: (message: string) => void;
  checkpoint?: () => void | Promise<void>;
  hooks?: {
    beforeNewTask?: (
      task: AICharacterTask,
      previous: AgentRunState,
    ) => Promise<void>;
  };
};
