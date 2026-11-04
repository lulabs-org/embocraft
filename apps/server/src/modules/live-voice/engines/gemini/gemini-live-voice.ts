import WebSocket from 'ws';
import type { LiveVoiceOptions, LiveVoiceSession } from '../../ports';

type Connector = (key: string) => WebSocket;
const connect: Connector = (key) =>
  new WebSocket(
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`,
    {
      handshakeTimeout: 10000,
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
    },
  );

/** Gemini Live accepts 16 kHz PCM and produces 24 kHz PCM. */
export class GeminiLiveVoice implements LiveVoiceSession {
  readonly inputSampleRate = 16000 as const;
  private readonly socket: WebSocket;
  private state: 'connecting' | 'ready' | 'closed' = 'connecting';
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout>;
  constructor(
    private readonly options: LiveVoiceOptions,
    connector: Connector = connect,
  ) {
    this.socket = connector(options.apiKey);
    this.timer = setTimeout(() => this.fail('实时语音连接超时。'), 15000);
    this.socket.on('open', () =>
      this.send({
        setup: {
          model: `models/${options.model}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: options.voice },
              },
            },
          },
          systemInstruction: { parts: [{ text: options.instructions }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'delegate_to_agent',
                  description:
                    'Ask the game agent to carry out a requested task or inspect the world.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      request: {
                        type: 'STRING',
                        description: 'The player request in context',
                      },
                    },
                    required: ['request'],
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    this.socket.on('message', (data, binary) => {
      if (this.state === 'closed') return;
      try {
        if (binary) throw Error('binary');
        const value = JSON.parse(data.toString());
        if (value.error)
          return this.fail(
            'Gemini 实时语音服务拒绝请求，请检查密钥和模型权限。',
          );
        if (value.setupComplete && this.state === 'connecting') {
          this.state = 'ready';
          clearTimeout(this.timer);
          options.events.ready();
        }
        const content = value.serverContent;
        for (const [field, speaker] of [
          ['inputTranscription', 'human'],
          ['outputTranscription', 'agent'],
        ] as const) {
          const text = content?.[field]?.text;
          if (text !== undefined) {
            if (typeof text !== 'string' || text.length > 8000)
              throw Error('transcript');
            options.events.transcript(speaker, text);
          }
        }
        const parts = content?.modelTurn?.parts;
        if (parts !== undefined) {
          if (!Array.isArray(parts) || parts.length > 100) throw Error('parts');
          for (const part of parts)
            if (part.inlineData) {
              const { data: encoded, mimeType } = part.inlineData;
              if (
                typeof encoded !== 'string' ||
                encoded.length > 90000 ||
                typeof mimeType !== 'string' ||
                !/^audio\/pcm(?:;\s*rate=24000)?$/i.test(mimeType)
              )
                throw Error('audio');
              const pcm = Buffer.from(encoded, 'base64');
              if (!pcm.length || pcm.length % 2) throw Error('audio');
              options.events.audio(pcm, 24000);
            }
        }
        if (content?.interrupted) options.events.interrupted();
        if (content?.turnComplete) options.events.transcriptEnd();
        const calls = value.toolCall?.functionCalls;
        if (calls !== undefined) {
          if (!Array.isArray(calls) || calls.length > 16) throw Error('calls');
          for (const call of calls) {
            if (
              call.name !== 'delegate_to_agent' ||
              typeof call.id !== 'string' ||
              call.id.length > 512 ||
              typeof call.args?.request !== 'string' ||
              call.args.request.length > 4000
            )
              throw Error('call');
            if (!this.pending.has(call.id)) {
              this.pending.add(call.id);
              options.events.delegation(call.id, call.args.request);
            }
          }
        }
        const cancelled = value.toolCallCancellation?.ids;
        if (cancelled !== undefined) {
          if (!Array.isArray(cancelled) || cancelled.length > 16)
            throw Error('cancel');
          for (const id of cancelled)
            if (typeof id === 'string' && this.pending.delete(id))
              options.events.cancelDelegation(id);
        }
      } catch {
        this.fail('Gemini 实时语音服务返回了无效响应。');
      }
    });
    this.socket.on('error', () => this.fail('无法连接 Gemini 实时语音服务。'));
    this.socket.on('unexpected-response', (_req, response) => {
      response.destroy();
      this.fail('Gemini 实时语音连接失败，请检查密钥和模型权限。');
    });
    this.socket.on('close', () => {
      if (this.state !== 'closed') this.fail('Gemini 实时语音连接已中断。');
    });
  }
  private send(event: object) {
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(event));
  }
  private fail(message: string) {
    if (this.state === 'closed') return;
    this.options.events.error(message);
    this.close();
  }
  sendAudio(pcm: Buffer) {
    if (this.state !== 'ready') return;
    if (
      !pcm.length ||
      pcm.length % 2 ||
      pcm.length > 3200 ||
      this.socket.bufferedAmount > 128000
    )
      return this.fail('实时语音音频格式无效或网络拥堵。');
    this.send({
      realtimeInput: {
        audio: {
          data: pcm.toString('base64'),
          mimeType: 'audio/pcm;rate=16000',
        },
      },
    });
  }
  updateContext(text: string) {
    if (this.state === 'ready' && text)
      this.send({
        realtimeInput: { text: `[游戏状态更新] ${text.slice(0, 1500)}` },
      });
  }
  deliverDelegation(id: string, result: string) {
    if (this.state === 'ready' && this.pending.delete(id))
      this.send({
        toolResponse: {
          functionResponses: [
            {
              id,
              name: 'delegate_to_agent',
              response: { result: result.slice(0, 4000) },
            },
          ],
        },
      });
  }
  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearTimeout(this.timer);
    this.socket.terminate();
    this.options.events.closed();
  }
}
