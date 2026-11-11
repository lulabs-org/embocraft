import type { CharacterReadPort } from '../modules/ai-characters/persistence';
import type { TaskQueryPort } from '../modules/tasks/persistence';
import type { ArchivePort } from './management-archive';

/** Composition bundle: targeted queries and the existing joint writer share one database. */
export interface ManagementStore extends ArchivePort {
  readonly characters: CharacterReadPort;
  readonly tasks: TaskQueryPort;
}
