import type { AICharacterView } from '@voxel/shared';
import type { AgentRunState } from '@voxel/agent-runtime';
import type { TaskBook } from '../../tasks';

export type CharacterRecord = AICharacterView & {
  runtime?: AgentRunState;
  taskBook?: TaskBook; // Legacy read only.
  currentRunId?: string;
};
