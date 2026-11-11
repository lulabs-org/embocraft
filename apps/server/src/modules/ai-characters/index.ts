export {
  AICharacterOrchestrator,
  bindCharacterOrchestrator,
  getActiveCharacterOrchestrator,
  type AICharacterDependencies,
} from './application/character-orchestrator';
export { createAICharacterOrchestrator } from './composition';
export {
  CharacterLogService,
  type CharacterLogQueryOptions,
} from './application/character-log-query';
export {
  appendAICharacterLog,
  restoreAICharacterLogs,
} from './domain/activity-log';
export { validateAICharacter } from './domain/character-settings';
export { taskExecutionState } from './integrations/task-execution-adapter';
export { CharacterVoiceCoordinator } from './integrations/voice-coordinator';
export {
  CharacterQueries,
  characterQueries,
} from './persistence/character-queries';
export type { CharacterRecord } from './persistence/character-record';
export { CharacterSnapshots } from './persistence/character-snapshots';
export type {
  AICharacterRoutePort,
  CharacterDetail,
  CharacterQueryPort,
} from './ports';
export { createAICharacterRouter } from './routes/ai-characters.routes';
export {
  CharacterExecutionService,
  protectCharactersAfterStorageFailure,
} from './runtime/character-execution';
export { AICharacterHost } from './runtime/character-host';
export {
  AICharacterRegistry,
  active,
  canWakeJob,
  isJobBusy,
  resident,
  type HostedAICharacter,
  type Job,
} from './runtime/character-registry';
export type { ExecutionContext } from './runtime/execution-context';
export { AICharacterWakeScheduler } from './runtime/wake-scheduler';
export { handleWorldEvent } from './runtime/world-event-handler';
