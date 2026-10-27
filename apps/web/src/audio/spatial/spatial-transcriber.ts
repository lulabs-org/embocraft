import { LiveRecorder } from '../recording/live-recorder';
import { speechTransport } from '../services/live-speech';
import { BailianSpeechSession } from '../services/bailian-speech';
import { BrowserRecognitionSession } from '../services/browser-recognition';
import { serverHttpUrl } from '../../network/endpoints';
import type { AsrChoice } from '../services/asr-choice';
export type TranscriptionState = {
  status: string;
  text: string;
  partial: string;
  error: string;
};
/** Shares the spatial microphone. Only the final endpoint may publish to listeners. */
export class SpatialTranscriber {
  private state: TranscriptionState = {
    status: '麦克风开启时自动转写',
    text: '',
    partial: '',
    error: '',
  };
  private browser?: BrowserRecognitionSession;
  private publishAbort?: AbortController;
  private generation = 0;
  private publishQueue = Promise.resolve();
  constructor(
    private token: () => string,
    private changed: (state: TranscriptionState) => void,
    private request: typeof fetch = (input, init) => fetch(input, init),
    private live = new LiveRecorder(),
    private createBrowser = () => new BrowserRecognitionSession(),
  ) {}
  private report(update: Partial<TranscriptionState>) {
    this.state = { ...this.state, ...update };
    this.changed({ ...this.state });
  }
  async start(stream: MediaStream, choice?: AsrChoice) {
    this.stop();
    const generation = this.generation;
    this.report({ text: '', partial: '', error: '' });
    const language = choice?.language ?? 'zh-CN';
    const external =
      choice?.provider === 'bailian' || choice?.provider === 'browser';
    const confirmed = (text: string) => {
      if (generation !== this.generation) return;
      if (external) {
        this.publishQueue = this.publishQueue.then(async () => {
          try {
            await this.publishText(text, generation);
            if (generation === this.generation)
              this.report({
                text,
                error: '',
                status: '整句已确认并送达附近听者，继续听取讲话…',
              });
          } catch (error) {
            if (generation === this.generation)
              this.report({
                error:
                  error instanceof Error ? error.message : '附近文字发送失败。',
                partial: '',
              });
          }
        });
      } else
        this.report({
          text,
          error: '',
          status: '整句已确认并送达附近听者，继续听取讲话…',
        });
    };
    const events = {
      onState: (_state: 'listening' | 'thinking', status: string) =>
        this.report({ status }),
      onStatus: (status: string) => this.report({ status }),
      onPartial: (partial: string) => this.report({ partial }),
      onFinal: confirmed,
      onError: (error: string) =>
        this.report({
          partial: '',
          error,
          status: '转写已停止，实时音频仍可使用',
        }),
      onEnd: () =>
        this.report({
          partial: '',
          status: '本次转写已结束，重新开启麦克风可继续',
        }),
    };
    if (choice?.provider === 'browser') {
      this.browser = this.createBrowser();
      this.browser.start(language, events);
      return;
    }
    await this.live.start(
      language,
      events,
      stream,
      choice?.provider === 'bailian'
        ? undefined
        : speechTransport(language, this.token, this.request, choice?.id),
      choice?.provider === 'bailian'
        ? (sessionEvents) =>
            new BailianSpeechSession(choice.id, language, sessionEvents)
        : undefined,
    );
  }
  private async publishText(text: string, generation: number) {
    const controller = new AbortController();
    this.publishAbort = controller;
    const token = this.token();
    const request = (path: string, body?: string) =>
      this.request(`${serverHttpUrl()}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
        signal: controller.signal,
      });
    let id = '';
    let published = false;
    try {
      const start = await request('/chat/spatial/start');
      if (!start.ok) throw Error('无法创建附近语音片段。');
      id = ((await start.json()) as { id: string }).id;
      if (generation !== this.generation) return;
      const response = await request(
        `/chat/spatial/${encodeURIComponent(id)}/text`,
        JSON.stringify({ text }),
      );
      if (!response.ok) {
        const value = (await response.json()) as { error?: string };
        throw Error(value.error || '附近文字发送失败。');
      }
      published = true;
    } finally {
      if (this.publishAbort === controller) this.publishAbort = undefined;
      if (id && !published)
        void this.request(
          `${serverHttpUrl()}/chat/spatial/${encodeURIComponent(id)}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5000),
          },
        ).catch(() => {});
    }
  }
  stop() {
    this.generation++;
    this.publishAbort?.abort();
    this.browser?.cancel();
    this.browser = undefined;
    this.live.cancel();
    this.report({ status: '转写已停止', partial: '', error: '' });
  }
}
