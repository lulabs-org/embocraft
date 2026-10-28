import type { AgentConfig } from '../contracts';

/** Draw a fresh inclusive interval after a completed turn; requests never overlap. */
export function nextIntervalMs(
  config: Pick<
    AgentConfig,
    'intervalMode' | 'intervalMs' | 'intervalMinMs' | 'intervalMaxMs'
  >,
  random = Math.random,
): number {
  return config.intervalMode === 'random'
    ? config.intervalMinMs +
        Math.floor(random() * (config.intervalMaxMs - config.intervalMinMs + 1))
    : config.intervalMs;
}
