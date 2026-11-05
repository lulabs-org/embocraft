export interface VoiceServicePort {
  get(id: string): Promise<unknown>;
  bind(sessionId: string, serviceId: string): Promise<void>;
  unbind(sessionId: string): void;
  remove(id: string, inUse: () => boolean): Promise<void>;
}
