import { domainEvents } from '../../core/events/domain-events';
import { AppError } from '../../core/errors/app-error';
import type { VoiceServiceCoordination } from './ports';

const conflict = () =>
  new AppError(
    '有 Agent 正在引用此服务或保存参数，请先完成更新，并在编辑参数中更换或移除语音服务。',
    409,
  );

/** Coordinates in-flight reference creation and deletion within this server process. */
export class VoiceServiceReferenceCoordinator
  implements VoiceServiceCoordination
{
  private readonly removing = new Set<string>();
  private readonly references = new Map<string, number>();

  async withReference<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (!id) return operation();
    if (this.removing.has(id)) throw conflict();
    this.references.set(id, (this.references.get(id) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const count = this.references.get(id)! - 1;
      if (count === 0) this.references.delete(id);
      else this.references.set(id, count);
    }
  }

  async withRemoval<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.removing.has(id) || this.references.has(id)) throw conflict();
    this.removing.add(id);
    try {
      return await operation();
    } finally {
      this.removing.delete(id);
    }
  }

  assertRemovable(id: string): void {
    domainEvents.emit('tts.service.removing', { serviceId: id });
  }

  notifyChanged(id: string): boolean {
    return domainEvents.emitSettled('tts.service.changed', { serviceId: id });
  }
}

export const voiceServiceCoordination = new VoiceServiceReferenceCoordinator();

/** Reserve a voice while an Agent reference or runtime binding is being established. */
export function withVoiceServiceReference<T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  return voiceServiceCoordination.withReference(id, operation);
}
