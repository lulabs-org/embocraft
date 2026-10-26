import { LocalSpeech } from '../audio/asr/local-speech';
import { scheduleSpeech } from '../audio/asr/speech-scheduler';
import type { WorldChat } from './chat';

type AudioInput = {
  chat: WorldChat;
  actor: string;
  route: unknown;
  bytes: Buffer;
  contentType: string;
  language: 'en' | 'zh';
  token: string;
  signal: AbortSignal;
};

type SpatialInput = Omit<AudioInput, 'route' | 'language'> & {
  id: string;
  partial: boolean;
};

/** Coordinates ASR with chat authorization and ticket lifetimes. */
export class ChatSpeechService {
  constructor(private speech: LocalSpeech) {}

  async publishAudio({
    chat,
    actor,
    route,
    bytes,
    contentType,
    language,
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
        text = await scheduleSpeech(this.speech).transcribe(
          normalized.bytes,
          'audio/wav',
          language,
          signal,
        );
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
    token,
    signal: requestSignal,
  }: SpatialInput) {
    try {
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
      );
      signal.throwIfAborted();
      chat.authenticate(token);
      if (partial) {
        chat.previewSpatial(actor, id);
        return { text };
      }
      return chat.publishSpatial(actor, id, text);
    } finally {
      if (!partial) chat.endSpatial(actor, id);
    }
  }
}
