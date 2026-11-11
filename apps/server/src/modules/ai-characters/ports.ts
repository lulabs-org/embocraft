import type {
  AICharacterLogEntry,
  AICharacterSummary,
  AICharacterView,
} from '@voxel/shared';
import type { TaskIdentity } from '@voxel/shared/management';
import type { CharacterRecord } from './persistence/character-record';

/** Internal reads are independent of the joint write/recovery archive. */
export interface CharacterReadPort {
  record(id: string): Promise<CharacterRecord>;
  view(id: string): Promise<AICharacterView>;
  views(): Promise<AICharacterView[]>;
  hasProviderReference(id: string): Promise<boolean>;
  hasVoiceServiceReference(id: string): Promise<boolean>;
}

export type CharacterDetail = AICharacterSummary & {
  taskIdentity: TaskIdentity | null;
};

export interface CharacterQueryPort {
  get(id: string): Promise<CharacterDetail>;
  list(): Promise<CharacterDetail[]>;
  logs(
    id: string,
    limit: number,
    offset: number,
  ): Promise<{
    entries: AICharacterLogEntry[];
    total: number;
  }>;
}

export type AICharacterRoutePort = {
  assertWritable(id?: string): void;
  create(value: unknown): Promise<AICharacterSummary>;
  flush(since?: number): Promise<void>;
  join(id: string): Promise<AICharacterSummary>;
  sessionId(id: string): string | undefined;
  remove(id: string): Promise<void>;
  setVoice(id: string, value: unknown): Promise<AICharacterSummary>;
  settled(id: string): Promise<void>;
  stop(id: string): AICharacterSummary | Promise<AICharacterSummary>;
  readonly storageRevision: number;
  update(id: string, value: unknown): Promise<AICharacterSummary>;
  readonly events: { readonly version: number };
};
