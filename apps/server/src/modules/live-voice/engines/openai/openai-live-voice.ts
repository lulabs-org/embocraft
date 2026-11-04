import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { LiveVoiceOptions, LiveVoiceSession } from '../../ports';

type Connector = (key: string) => WebSocket;
const connect: Connector = (key) =>
  new WebSocket('wss://api.openai.com/v1/live/sessions', {
    headers: { Authorization: `Bearer ${key}` },
    handshakeTimeout: 10000,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
  });

/** GPT-Live carries 24 kHz mono PCM in both directions. */
export class OpenAILiveVoice implements LiveVoiceSession {
  readonly inputSampleRate = 24000 as const;
  private readonly socket: WebSocket;
  private state: 'connecting' | 'ready' | 'closing' | 'closed' = 'connecting';
  private timer: ReturnType<typeof setTimeout>;
  constructor(
    private readonly options: LiveVoiceOptions,
    connector: Connector = connect,
  ) {
    this.socket = connector(options.apiKey);
    this.timer = setTimeout(() => this.fail('实时语音连接超时。'), 15000);
    this.socket.on('open', () =>
      this.send({
        type: 'session.start',
        session: {
          model: options.model,
          instructions: options.instructions,
          audio: {
            format: { type: 'audio/pcm', rate: 24000 },
            output: { voice: options.voice },
          },
          delegation: { type: 'client' },
        },
      }),
    );
    this.socket.on('message', (data, binary) => {
      if (this.state === 'closed') return;
      try {
        if (binary) throw Error('binary');
        const value = JSON.parse(data.toString());
        if (value.type === 'error')
          return this.fail(
            'OpenAI 实时语音服务拒绝请求，请检查密钥和模型权限。',
          );
        if (value.type === 'session.started' && this.state === 'connecting') {
          this.state = 'ready';
          clearTimeout(this.timer);
          options.events.ready();
        } else if (
          value.type === 'session.output_audio.delta' &&
          this.state === 'ready'
        ) {
          if (typeof value.delta !== 'string' || value.delta.length > 90000)
            throw Error('audio');
          const audio = Buffer.from(value.delta, 'base64');
          if (!audio.length || audio.length % 2) throw Error('audio');
          options.events.audio(audio, 24000);
        } else if (
          value.type === 'session.input_transcript.delta' ||
          value.type === 'session.output_transcript.delta'
        ) {
          if (typeof value.delta !== 'string' || value.delta.length > 8000)
            throw Error('transcript');
          options.events.transcript(
            value.type === 'session.input_transcript.delta' ? 'human' : 'agent',
            value.delta,
            Number.isFinite(value.start_ms) && Number.isFinite(value.end_ms)
              ? { startMs: value.start_ms, endMs: value.end_ms }
              : undefined,
          );
        } else if (
          value.type === 'session.delegation.created' &&
          value.delegation?.target === 'client'
        ) {
          if (
            typeof value.delegation.id !== 'string' ||
            value.delegation.id.length > 512
          )
            throw Error('delegation');
          options.events.delegation(
            value.delegation.id,
            undefined,
            Number.isFinite(value.offset_ms) ? value.offset_ms : undefined,
          );
        } else if (value.type === 'session.closed') this.end();
      } catch {
        this.fail('OpenAI 实时语音服务返回了无效响应。');
      }
    });
    this.socket.on('error', () => this.fail('无法连接 OpenAI 实时语音服务。'));
    this.socket.on('unexpected-response', (_req, response) => {
      response.destroy();
      this.fail('OpenAI 实时语音连接失败，请检查密钥和模型权限。');
    });
    this.socket.on('close', () => {
      if (this.state === 'closing') this.end();
      else if (this.state !== 'closed')
        this.fail('OpenAI 实时语音连接已中断。');
    });
  }
  private send(event: object) {
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(event));
  }
  private fail(message: string) {
    if (this.state === 'closed') return;
    this.options.events.error(message);
    this.end();
  }
  private end() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearTimeout(this.timer);
    this.socket.terminate();
    this.options.events.closed();
  }
  sendAudio(pcm: Buffer) {
    if (this.state !== 'ready') return;
    if (
      !pcm.length ||
      pcm.length % 2 ||
      pcm.length > 4800 ||
      this.socket.bufferedAmount > 128000
    )
      return this.fail('实时语音音频格式无效或网络拥堵。');
    this.send({
      type: 'session.input_audio.append',
      audio: pcm.toString('base64'),
    });
  }
  updateContext(text: string) {
    if (this.state === 'ready' && text)
      this.send({
        type: 'session.instructions.append',
        event_id: randomUUID(),
        delegation_id: null,
        content: text.slice(0, 1500),
      });
  }
  deliverDelegation(id: string, result: string) {
    if (this.state === 'ready' && id && result)
      this.send({
        type: 'session.commentary.append',
        event_id: randomUUID(),
        delegation_id: id,
        content: result.slice(0, 4000),
      });
  }
  close() {
    if (this.state === 'closed' || this.state === 'closing') return;
    if (this.state !== 'ready') return this.end();
    this.state = 'closing';
    this.send({ type: 'session.close' });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.end(), 5000);
  }
}
