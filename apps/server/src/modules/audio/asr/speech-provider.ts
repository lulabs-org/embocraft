import { env } from '../../../config/env';
import type { AsrProviderName } from '../../../config/env';
import { AppError } from '../../../common/errors';
import { LocalSpeech } from './local-speech';
import { SenseVoiceSpeech } from './sense-voice-speech';
import { listSenseVoiceModels } from './sense-voice-models';
import type {
  SpeechSettings,
  SpeechStatus,
  SpeechTranscriber,
} from './speech-transcriber';

/** Engine selection for `ASR_PROVIDER`; profiles from the console pick their own engine. */
export type SpeechRouterOptions = {
  whisper?: SpeechTranscriber;
  senseVoice?: SpeechTranscriber;
  /** Pins the engine for requests without a saved profile, overriding `ASR_PROVIDER`. */
  default?: SpeechTranscriber;
  provider?: AsrProviderName;
  models?: () => { name: string }[] | Promise<{ name: string }[]>;
};

type Profile = { provider?: 'bailian' | 'whisper' | 'sense-voice' };

/**
 * Owns the server's speech-to-text engines.
 * Saved services route by provider; chat voice and nearby speech captions
 * carry no profile and use `default`, which follows `ASR_PROVIDER`.
 */
export class SpeechRouter {
  readonly whisper: SpeechTranscriber;
  readonly senseVoice: SenseVoiceSpeech | SpeechTranscriber;
  readonly default: SpeechTranscriber;
  constructor(options: SpeechRouterOptions = {}) {
    this.whisper = options.whisper ?? new LocalSpeech();
    this.senseVoice = options.senseVoice ?? new SenseVoiceSpeech();
    const provider = options.provider ?? env.readSpeech().asrProvider;
    this.default = options.default
      ? options.default
      : provider === 'sense-voice'
        ? this.senseVoice
        : provider === 'whisper'
          ? this.whisper
          : new AutoSpeech(this.whisper, this.senseVoice, options.models);
  }
  /** Requests without a saved profile use `default`, so only the others dispatch. */
  engineFor(profile?: Profile) {
    if (!profile) return this.default;
    if (profile.provider === 'whisper') return this.whisper;
    if (profile.provider === 'sense-voice') return this.senseVoice;
    throw new AppError('请选择服务器音频识别服务。');
  }
}

/** Prefers the local SenseVoice graph when installed, otherwise self-hosted Whisper. */
class AutoSpeech implements SpeechTranscriber {
  private choice?: Promise<SpeechTranscriber>;
  constructor(
    private whisper: SpeechTranscriber,
    private senseVoice: SpeechTranscriber,
    private models: () =>
      | { name: string }[]
      | Promise<{ name: string }[]> = listSenseVoiceModels,
  ) {}
  private engine() {
    return (this.choice ??= Promise.resolve(this.models()).then((models) =>
      models.length ? this.senseVoice : this.whisper,
    ));
  }
  async status(settings?: SpeechSettings): Promise<SpeechStatus> {
    return (await this.engine()).status(settings);
  }
  async normalize(audio: Buffer, contentType: string, signal: AbortSignal) {
    return (await this.engine()).normalize(audio, contentType, signal);
  }
  async transcribe(
    audio: Buffer,
    contentType: string,
    language: string,
    signal: AbortSignal,
    settings?: SpeechSettings,
  ) {
    return (await this.engine()).transcribe(
      audio,
      contentType,
      language,
      signal,
      settings,
    );
  }
}

/** Shared routers keep one model session and one inference queue per process. */
const shared: {
  whisper?: LocalSpeech;
  senseVoice?: SenseVoiceSpeech;
  router?: SpeechRouter;
} = {};
export function whisperSpeech() {
  return (shared.whisper ??= new LocalSpeech());
}
export function senseVoiceSpeech() {
  return (shared.senseVoice ??= new SenseVoiceSpeech());
}
export function speechRouter() {
  return (shared.router ??= new SpeechRouter({
    whisper: whisperSpeech(),
    senseVoice: senseVoiceSpeech(),
  }));
}
