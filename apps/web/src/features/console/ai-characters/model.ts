import type { AICharacterSettings } from '@voxel/shared';

export const initialAICharacter: AICharacterSettings = {
  providerId: '',
  model: '',
  name: '',
  roleDescription: '',

  intervalMode: 'fixed',
  intervalMinMs: 4000,
  intervalMaxMs: 8000,
  taskLimitsEnabled: false,
  maxTurns: 100,
  tokenBudget: 50000,
  taskTimeoutMs: 900000,
  intervalMs: 3000,
  timeoutMs: 60000,
  maxTokens: 512,
  permissions: { move: true, chat: true, place: false, remove: false },
  skills: [],
  voiceReplies: false,
  voiceServiceId: '',
  thinking: 'disabled',
  reasoningEffort: 'high',
};
