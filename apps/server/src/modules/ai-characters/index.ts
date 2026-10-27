export {
  AICharacterOrchestrator,
  type AICharacterDependencies,
} from './services/orchestrator.service';
export { AICharacterManager } from './services/character.manager';
export { CharacterVoiceCoordinator } from './services/voice-coordinator.service';
export { validateAICharacter } from './domain/validation';
export {
  appendAICharacterLog,
  migrateLegacyLogs,
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
} from './services/job';
export type { VoiceServicePort } from './ports';
export type { CharacterRecord } from './persistence/record';
export { taskExecutionState, executionState } from './services/task-adapter';
export { AICharacterWakeScheduler } from './services/wake-scheduler.service';
export { AICharacterHost } from './services/character-host.service';
export type { ExecutionContext } from './services/execution-context';
export { handleWorldEvent } from './services/world-event-handler';
export {
  installAICharacterRoutes,
  type AICharacterRoutePort,
} from './routes/ai-characters.routes';
