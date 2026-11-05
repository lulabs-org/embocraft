import { EventEmitter } from 'node:events';

export type DomainEventMap = {
  'tts.service.removing': { serviceId: string };
  'tts.service.changed': { serviceId: string };
  'agent.voice.bound': { sessionId: string; serviceId: string };
  'agent.voice.unbound': { sessionId: string };
  'provider.removing': { providerId: string };
  'provider.changed': { providerId: string };
};

type Listener<T> = (payload: T) => void;

/**
 * 进程内轻量级领域事件总线，用于跨模块解耦通知与同步前置校验。
 */
export class DomainEventBus {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  on<K extends keyof DomainEventMap>(
    event: K,
    listener: Listener<DomainEventMap[K]>,
  ): () => void {
    if (!this.emitter.listeners(event).includes(listener)) {
      this.emitter.on(event, listener);
    }
    return () => this.emitter.off(event, listener);
  }

  emit<K extends keyof DomainEventMap>(
    event: K,
    payload: DomainEventMap[K],
  ): void {
    this.emitter.emit(event, payload);
  }

  /** Deliver post-commit notifications to every listener without propagating failures. */
  emitSettled<K extends keyof DomainEventMap>(
    event: K,
    payload: DomainEventMap[K],
  ): boolean {
    let failed = false;
    for (const listener of this.emitter.rawListeners(event)) {
      try {
        listener.call(this.emitter, payload);
      } catch {
        failed = true;
      }
    }
    return !failed;
  }

  clear(): void {
    this.emitter.removeAllListeners();
  }
}

export const domainEvents = new DomainEventBus();
