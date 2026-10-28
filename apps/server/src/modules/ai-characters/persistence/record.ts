import type { RuntimeState } from '@voxel/agent-runtime';
import type { AICharacterView } from '@voxel/shared';

export type CharacterRecord = AICharacterView & {
  runtime?: RuntimeState;
  currentRunId?: string;
};
