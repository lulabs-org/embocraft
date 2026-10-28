import type { AgentConfig } from '@voxel/agent-runtime';

/** Explicit test inputs, independent of CLI defaults and the developer's environment. */
export function testAgentConfig(
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return {
    apiKey: 'fixture',
    name: 'Test Agent',
    model: 'deepseek-flash',
    goal: '观察附近环境并回应玩家。',
    permissions: { move: true, chat: true, place: false, remove: false },
    voiceReplies: false,

    intervalMode: 'fixed',
    intervalMinMs: 4000,
    intervalMaxMs: 8000,
    thinking: 'disabled',
    reasoningEffort: 'high',
    maxTokens: 512,
    maxTurns: 100,
    tokenBudget: 50000,
    taskTimeoutMs: 900000,
    intervalMs: 3000,
    timeoutMs: 30000,
    ...overrides,
  };
}
