import type { VoiceServiceView } from '@voxel/shared';

export interface VoiceServicePort {
  list(): VoiceServiceView[];
  get(id: string): unknown;
  bind(sessionId: string, serviceId: string): void;
  unbind(sessionId: string): void;
  remove(id: string, inUse: () => boolean): Promise<void>;
}
