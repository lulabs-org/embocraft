import { DEFAULT_WHISPER_ASR } from '@voxel/shared';
import {
  AsrSettingsStore,
  scheduleSpeech,
  settingsFor,
  type SpeechRouter,
} from '../../asr';
import type { WorldChat } from './chat.service';

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
    private speech: SpeechRouter,
    private asrSettings: AsrSettingsStore,
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
        ? this.asrSettings.acquire(serviceId)
        : undefined;
      try {
        const profile = selected?.settings;
        const engine = this.speech.engineFor(profile);
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
          // A failed transcript must not drop the recording: the audio still publishes
          // with empty text, while a genuine abort keeps cancelling the upload.
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
      ? this.asrSettings.acquire(serviceId)
      : undefined;
    try {
      const profile = selected?.settings;
      const engine = this.speech.engineFor(profile);
      const signal = AbortSignal.any([
        requestSignal,
        partial ? chat.previewSpatial(actor, id) : chat.claimSpatial(actor, id),
      ]);
      // Nearby transcripts are published without review, so Whisper keeps temperature 0;
      // SenseVoice has no sampling temperature and uses the saved language as-is.
      const settings =
        profile?.provider === 'whisper'
          ? { ...profile, temperature: 0 }
          : profile?.provider === 'sense-voice'
            ? profile
            : { ...DEFAULT_WHISPER_ASR, temperature: 0 };
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
