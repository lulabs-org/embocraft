import {
  asrService,
  scheduleSpeech,
  settingsFor,
  speechRouter,
  type AsrService,
  type SpeechRouter,
  type SpeechSettings,
} from '../../asr';
import type { WorldChat } from './chat.service';
import { DEFAULT_WHISPER_ASR } from '@voxel/shared';

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
  language?: string;
};

/** Coordinates ASR with chat authorization and ticket lifetimes. */
export class ChatSpeechService {
  constructor(
    private speech: SpeechRouter = speechRouter,
    private asrSettings: AsrService = asrService,
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
      const selected = serviceId
        ? await this.asrSettings.acquire(serviceId)
        : undefined;
      try {
        const profile = selected?.settings;
        // 已保存的配置固定使用自己的引擎；未指定配置的上传按 ASR_PROVIDER 选择。
        const engine = await this.speech.engineFor(profile);
        const normalized = await engine.normalize(bytes, contentType, signal);
        let text = '';
        try {
          text = await scheduleSpeech(engine).transcribe(
            normalized.bytes,
            'audio/wav',
            language,
            signal,
            false,
            settingsFor(profile),
          );
        } catch {
          // 转写失败不能丢弃录音：音频仍以空文本发布；
          // 只有真正的取消才继续中止上传。
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
        selected?.release();
      }
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
    language = 'auto',
    token,
    signal: requestSignal,
  }: SpatialInput) {
    const selected = serviceId
      ? await this.asrSettings.acquire(serviceId)
      : undefined;
    try {
      const profile = selected?.settings;
      const engine = await this.speech.engineFor(profile);
      const signal = AbortSignal.any([
        requestSignal,
        partial ? chat.previewSpatial(actor, id) : chat.claimSpatial(actor, id),
      ]);
      // 附近语音会直接发布，因此 Whisper 固定温度为 0；
      // SenseVoice 没有采样温度，直接使用保存的识别语言。
      const settings: SpeechSettings | undefined =
        profile?.provider === 'whisper'
          ? { ...profile, temperature: 0 }
          : profile?.provider === 'sense-voice'
            ? profile
            : engine.provider === 'whisper'
              ? { ...DEFAULT_WHISPER_ASR, temperature: 0 }
              : undefined;
      const text = await scheduleSpeech(engine).transcribe(
        bytes,
        contentType,
        language,
        signal,
        partial,
        settings,
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
