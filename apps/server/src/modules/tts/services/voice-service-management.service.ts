import type { VoiceServiceView } from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import { domainEvents } from '../../../core/events/domain-events';
import type { SavedVoice } from '../domain/voice-service-validation';
import type { VoiceServicePersistence } from '../ports';
import { validateVoiceService } from '../domain/voice-service-validation';

const publicView = ({ apiKey, ...value }: SavedVoice): VoiceServiceView => ({
  ...value,
  capability: 'tts',
  hasApiKey: !!apiKey,
});

export class VoiceServiceManagement {
  constructor(private readonly storage: VoiceServicePersistence) {}

  private find(voice?: SavedVoice): SavedVoice {
    if (!voice) throw new AppError('语音服务不存在，请重新选择。', 404);
    if (typeof voice.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(voice.id))
      throw new AppError('语音服务数据库配置格式无效。', 500);
    return { ...validateVoiceService(voice), id: voice.id };
  }

  async list() {
    const saved = await this.storage.load();
    if (
      !Array.isArray(saved) ||
      saved.length > 20 ||
      new Set(saved.map((voice) => voice.id)).size !== saved.length
    )
      throw new AppError('语音服务数据库配置格式无效。', 500);
    return saved.map((voice) => publicView(this.find(voice)));
  }

  async get(id: string) {
    return this.find(await this.storage.get(id));
  }

  async save(value: unknown, id?: string) {
    const result = await this.storage.transaction(async (tx) => {
      if (!id && (await tx.count()) >= 20)
        throw new AppError('最多保存 20 个语音服务。');
      const entry = validateVoiceService(
        value,
        id ? this.find(await tx.get(id)) : undefined,
      );
      if (id) await tx.update(entry);
      else await tx.create(entry);
      return publicView(entry);
    });
    if (id) domainEvents.emit('tts.service.changed', { serviceId: id });
    return result;
  }

  async remove(id: string) {
    domainEvents.emit('tts.service.removing', { serviceId: id });
    await this.storage.transaction(async (tx) => {
      this.find(await tx.get(id));
      domainEvents.emit('tts.service.removing', { serviceId: id });
      await tx.remove(id);
    });
    domainEvents.emit('tts.service.changed', { serviceId: id });
  }
}
