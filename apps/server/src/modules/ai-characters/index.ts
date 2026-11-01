export {
  AICharacterOrchestrator,
  type AICharacterDependencies,
} from './services/orchestrator.service';
export { AICharacterManager } from './services/character-manager.service';
export {
  CharacterQueries,
  type CharacterQueryPort,
} from './persistence/queries';
export { CharacterVoiceCoordinator } from './services/voice-coordinator.service';
export { validateAICharacter } from './domain/validation';
export {
  appendAICharacterLog,
  restoreAICharacterLogs,
} from './domain/activity-log';
export {
  AICharacterRegistry,
  type Job,
  type HostedAICharacter,
  active,
  resident,
  isJobBusy,
  canWakeJob,
} from './services/character-job';
export type { VoiceServicePort } from './ports';
export type { CharacterRecord } from './persistence/record';
export { taskExecutionState, executionState } from './services/task-execution-adapter';
export { AICharacterWakeScheduler } from './services/wake-scheduler.service';
export { AICharacterHost } from './services/character-host.service';
export type { ExecutionContext } from './services/execution-context';
export { handleWorldEvent } from './services/world-event-handler';
export {
  CharacterLogService,
  type CharacterLogQueryOptions,
} from './services/character-log.service';
export {
  installAICharacterRoutes,
  type AICharacterRoutePort,
} from './routes/ai-characters.routes';
