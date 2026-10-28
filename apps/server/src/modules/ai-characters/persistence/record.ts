import type { AICharacterView } from '@voxel/shared';
import type { AgentRunState } from '@voxel/agent-runtime';

export type CharacterRecord = AICharacterView & {
  runtime?: AgentRunState;
  currentRunId?: string;
};
