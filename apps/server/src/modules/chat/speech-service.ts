import { LocalSpeech } from '../audio/asr/local-speech';
import { scheduleSpeech } from '../audio/asr/speech-scheduler';
import type { WorldChat } from './chat';
import { AsrSettingsStore } from '../audio/asr/asr-settings';
import { AppError } from '../../core/errors/app-error';

type AudioInput = {
  chat: WorldChat;
  actor: string;
  route: unknown;
  bytes: Buffer;
  contentType: string;
  language: 'en' | 'zh';
  serviceId?: string;
  token: string;
  signal: AbortSignal;
};

type SpatialInput = Omit<AudioInput, 'route' | 'language'> & {
  id: string;
  partial: boolean;
  serviceId?: string;
};

/** Coordinates ASR with chat authorization and ticket lifetimes. */
export class ChatSpeechService {
  constructor(
    private speech: LocalSpeech,
    private asrSettings = new AsrSettingsStore(),
  ) {}

  async publishAudio({
    chat,
    actor,
    route,
    bytes,
    contentType,
    language,
    serviceId,
    token,
    signal,
  }: AudioInput) {
    chat.beginUpload(actor, route);
    try {
      const normalized = await this.speech.normalize(
        bytes,
        contentType,
        signal,
      );
      let text = '';
      try {
        const selected = serviceId
          ? this.asrSettings.acquire(serviceId)
          : undefined;
        try {
          if (selected && selected.settings.provider !== 'whisper')
            throw new AppError('录制语音只能使用 Whisper 识别服务。');
          text = await scheduleSpeech(this.speech).transcribe(
            normalized.bytes,
            'audio/wav',
            language,
            signal,
            false,
            selected?.settings.provider === 'whisper'
              ? selected.settings
              : undefined,
          );
        } finally {
          selected?.release();
        }
      } catch {
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
      chat.authenticate(token);
      return chat.publishAudio(
        actor,
        route,
        normalized.bytes,
        normalized.durationMs,
        text,
      );
    } finally {
      chat.endUpload(actor);
    }
  }

  async transcribeSpatial({
    chat,
    actor,
    id,
    bytes,
    contentType,
    partial,
    serviceId,
    token,
    signal: requestSignal,
  }: SpatialInput) {
    const selected = serviceId
      ? this.asrSettings.acquire(serviceId)
      : undefined;
    try {
      if (selected && selected.settings.provider !== 'whisper')
        throw new AppError('请选择 Whisper 服务。');
      const signal = AbortSignal.any([
        requestSignal,
        partial ? chat.previewSpatial(actor, id) : chat.claimSpatial(actor, id),
      ]);
      const text = await scheduleSpeech(this.speech).transcribe(
        bytes,
        contentType,
        'zh',
        signal,
        partial,
        selected?.settings.provider === 'whisper'
          ? selected.settings
          : undefined,
      );
      signal.throwIfAborted();
      chat.authenticate(token);
      if (partial) {
        chat.previewSpatial(actor, id);
        return { text };
      }
      return chat.publishSpatial(actor, id, text);
    } finally {
      selected?.release();
      if (!partial) chat.endSpatial(actor, id);
    }
  }
}
