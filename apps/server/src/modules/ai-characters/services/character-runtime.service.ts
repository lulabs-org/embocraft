import type { AICharacterSummary } from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';

export type AICharacterRoutePort = {
  assertWritable(id?: string): void;
  create(value: unknown): Promise<AICharacterSummary>;
  flush(since?: number): Promise<void>;
  join(id: string): Promise<AICharacterSummary>;
  sessionId(id: string): string | undefined;
  remove(id: string): Promise<void>;
  setVoice(id: string, value: unknown): Promise<AICharacterSummary>;
  settled(id: string): Promise<void>;
  stop(id: string): AICharacterSummary;
  readonly storageRevision: number;
  update(id: string, value: unknown): Promise<AICharacterSummary>;
  readonly events: { readonly version: number };
};

let activeCharacterManager: AICharacterRoutePort | undefined;

export function bindCharacterManager(
  manager: AICharacterRoutePort,
): () => void {
  activeCharacterManager = manager;
  return () => {
    if (activeCharacterManager === manager) activeCharacterManager = undefined;
  };
}

export function getActiveCharacterManager(): AICharacterRoutePort {
  if (!activeCharacterManager)
    throw new AppError('AI 角色管理服务尚未就绪。', 503);
  return activeCharacterManager;
}
