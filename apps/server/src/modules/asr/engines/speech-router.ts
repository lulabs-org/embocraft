import type { AsrServiceDraft } from '@voxel/shared';
import { env, type AsrProviderName } from '../../../core/config/env';
import { AppError } from '../../../core/errors/app-error';
import { localSpeech, senseVoiceSpeech } from './index';
import { listSenseVoiceModels } from './sense-voice/sense-voice.models';
import type { SpeechSettings, SpeechTranscriberPort } from '../ports';

type Profile = {
  provider?: 'bailian' | 'whisper' | 'sense-voice' | 'openai' | 'gemini';
};

/** 云端配置有各自的传输通道，只有服务器内引擎接受这些配置。 */
export function settingsFor(
  view?: AsrServiceDraft,
): SpeechSettings | undefined {
  return view &&
    (view.provider === 'whisper' || view.provider === 'sense-voice')
    ? view
    : undefined;
}

export type SpeechRouterOptions = {
  whisper?: SpeechTranscriberPort;
  senseVoice?: SpeechTranscriberPort;
  /** 为未保存配置的请求固定引擎，覆盖 ASR_PROVIDER。 */
  provider?: AsrProviderName;
  models?: () => Promise<{ name: string }[]>;
};

/**
 * 管理进程内的语音识别引擎。
 * 已保存的服务按 provider 路由；聊天录音与附近语音字幕没有配置，改为跟随 ASR_PROVIDER。
 */
export class SpeechRouter {
  private readonly whisper: SpeechTranscriberPort;
  private readonly senseVoice: SpeechTranscriberPort;
  private readonly provider?: AsrProviderName;
  private readonly models: () => Promise<{ name: string }[]>;
  constructor(options: SpeechRouterOptions = {}) {
    this.whisper = options.whisper ?? localSpeech;
    this.senseVoice = options.senseVoice ?? senseVoiceSpeech;
    this.provider = options.provider;
    this.models = options.models ?? listSenseVoiceModels;
  }
  /** 未保存配置的请求使用默认引擎，因此只有其余情况才分发。 */
  async engineFor(profile?: Profile): Promise<SpeechTranscriberPort> {
    if (!profile) return this.defaultEngine();
    if (profile.provider === 'whisper') return this.whisper;
    if (profile.provider === 'sense-voice') return this.senseVoice;
    throw new AppError('请选择服务器音频识别服务。');
  }
  /** 已安装本地 SenseVoice 模型包时优先使用，否则回退自托管 Whisper。 */
  private async defaultEngine() {
    // 每次请求都读取，让 ASR_PROVIDER 保持为部署期决策，而不是模块导入期的一次性结果。
    const provider = this.provider ?? env.readSpeech().asrProvider;
    if (provider === 'sense-voice') return this.senseVoice;
    if (provider === 'whisper') return this.whisper;
    // 每次请求都检查，开发期间新增的模型无需重启即可生效。
    return (await this.models()).length ? this.senseVoice : this.whisper;
  }
}

/** 共享路由器让引擎单例与其解码队列保持一致。 */
export const speechRouter = new SpeechRouter();
