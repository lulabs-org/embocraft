export type DomainEventMap = {
  'tts.service.removing': { serviceId: string };
  'tts.service.changed': { serviceId: string };
  'agent.voice.bound': { sessionId: string; serviceId: string };
  'agent.voice.unbound': { sessionId: string };
};

type Listener<T> = (payload: T) => void;

/**
 * 进程内轻量级领域事件总线，用于跨模块解耦通知与同步前置校验。
 */
export class DomainEventBus {
  private readonly listeners = new Map<
    keyof DomainEventMap,
    Set<Listener<never>>
  >();

  on<K extends keyof DomainEventMap>(
    event: K,
    listener: Listener<DomainEventMap[K]>,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => {
      set.delete(listener as Listener<never>);
      if (set.size === 0) this.listeners.delete(event);
    };
  }

  emit<K extends keyof DomainEventMap>(
    event: K,
    payload: DomainEventMap[K],
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      (listener as Listener<DomainEventMap[K]>)(payload);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const domainEvents = new DomainEventBus();
