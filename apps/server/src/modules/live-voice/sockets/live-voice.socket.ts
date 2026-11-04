import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import { originAllowed } from '../../../core/http/origin-policy';
import { AppError } from '../../../core/errors/app-error';
import { Pcm16Upsampler } from '../../../core/audio/pcm-resample';
import type {
  LiveVoiceEvents,
  LiveVoiceOptions,
  LiveVoiceSession,
} from '../ports';
import type {
  LiveVoiceStore,
  SavedLiveVoice,
} from '../services/live-voice-store';
import { OpenAILiveVoice } from '../engines/openai/openai-live-voice';
import { GeminiLiveVoice } from '../engines/gemini/gemini-live-voice';

export type AuthorizedLiveConversation = {
  actorId: string;
  agentId: string;
  serviceId: string;
  instructions: string;
  /** Recheck identity, permissions, presence and range while audio is flowing. */
  valid(): boolean;
  delegate(request: string, signal: AbortSignal): Promise<string>;
  publishTranscript(text: string): void;
  publishHumanTranscript(text: string): void;
};
export type LiveVoiceAuthorization = (
  token: string,
  agentId: string,
) => AuthorizedLiveConversation;
type Factory = (
  settings: SavedLiveVoice,
  options: LiveVoiceOptions,
) => LiveVoiceSession;
const defaultFactory: Factory = (settings, options) =>
  settings.provider === 'openai'
    ? new OpenAILiveVoice(options)
    : new GeminiLiveVoice(options);

/** Each nearby Agent has its own provider session and receives the player's audio. */
export class LiveVoiceSockets {
  private readonly agents = new Set<string>();
  private readonly actorSessions = new Map<string, Set<string>>();
  private readonly clients = new Set<WebSocket>();
  constructor(
    private readonly store: LiveVoiceStore,
    private readonly authorize: LiveVoiceAuthorization,
    private readonly origin: string,
    private readonly factory: Factory = defaultFactory,
    private readonly maxSessions = 64,
  ) {}
  handle = (client: WebSocket, req: IncomingMessage) => {
    let closed = false,
      reserved = false,
      started = false,
      ready = false,
      bytesSent = 0;
    let session: LiveVoiceSession | undefined;
    let conversation: AuthorizedLiveConversation | undefined;
    let release: (() => void) | undefined;
    let begunAt = 0,
      heard = '',
      spoken = '',
      humanSpoken = '';
    let fragments: { text: string; startMs: number; endMs: number }[] = [];
    const pending = new Map<string, AbortController>();
    const seenDelegations = new Set<string>();
    const converter = new Pcm16Upsampler();
    let monitor: ReturnType<typeof setInterval> | undefined;
    let lifetime: ReturnType<typeof setTimeout> | undefined;
    let transcriptTimer: ReturnType<typeof setTimeout> | undefined;
    let humanTranscriptTimer: ReturnType<typeof setTimeout> | undefined;
    const flushHumanTranscript = () => {
      clearTimeout(humanTranscriptTimer);
      const text = humanSpoken.trim();
      humanSpoken = '';
      if (text && conversation?.valid())
        conversation.publishHumanTranscript(text);
    };
    const flushTranscript = () => {
      clearTimeout(transcriptTimer);
      const text = spoken.trim();
      spoken = '';
      if (text && conversation?.valid()) conversation.publishTranscript(text);
    };
    const send = (event: object) => {
      if (client.readyState === WebSocket.OPEN)
        client.send(JSON.stringify(event));
    };
    const cleanup = () => {
      if (closed) return;
      flushTranscript();
      flushHumanTranscript();
      closed = true;
      clearTimeout(startDeadline);
      clearTimeout(lifetime);
      clearInterval(monitor);
      for (const controller of pending.values()) controller.abort();
      pending.clear();
      if (conversation && reserved) {
        this.agents.delete(conversation.agentId);
        const sessions = this.actorSessions.get(conversation.actorId);
        sessions?.delete(conversation.agentId);
        if (!sessions?.size) this.actorSessions.delete(conversation.actorId);
      }
      this.clients.delete(client);
      release?.();
      session?.close();
      if (
        client.readyState === WebSocket.OPEN ||
        client.readyState === WebSocket.CONNECTING
      )
        client.close();
    };
    const fail = (message: string) => {
      if (!closed) {
        send({ type: 'error', message });
        cleanup();
      }
    };
    const startDeadline = setTimeout(() => fail('实时语音连接超时。'), 20000);
    this.clients.add(client);
    client.on('error', cleanup);
    client.on('close', cleanup);
    if (!originAllowed(req.headers.origin, this.origin)) {
      fail('不允许此页面访问实时语音。');
      return;
    }
    client.on('message', (data, binary) => {
      if (closed) return;
      if (!started) {
        try {
          if (binary || data.toString().length > 4096)
            throw new AppError('实时语音请求无效。');
          const value = JSON.parse(data.toString());
          if (
            value.type !== 'start' ||
            typeof value.token !== 'string' ||
            value.token.length > 256 ||
            typeof value.agentId !== 'string' ||
            !/^[\w-]{1,80}$/.test(value.agentId)
          )
            throw new AppError('实时语音请求无效。');
          conversation = this.authorize(value.token, value.agentId);
          if (!conversation.valid())
            throw new AppError('玩家或 Agent 已离开对话范围。', 409);
          if (this.agents.has(conversation.agentId))
            throw new AppError('Agent 已在实时对话中。', 409);
          if (this.agents.size >= this.maxSessions)
            throw new AppError('实时语音服务繁忙，请稍后重试。', 429);
          const lease = this.store.acquire(conversation.serviceId);
          release = lease.release;
          this.agents.add(conversation.agentId);
          reserved = true;
          started = true;
          begunAt = Date.now();
          const events: LiveVoiceEvents = {
            ready: () => {
              if (!closed && !ready) {
                ready = true;
                const sessions =
                  this.actorSessions.get(conversation!.actorId) ??
                  new Set<string>();
                sessions.add(conversation!.agentId);
                this.actorSessions.set(conversation!.actorId, sessions);
                clearTimeout(startDeadline);
                send({
                  type: 'ready',
                  inputSampleRate: 16000,
                  outputSampleRate: 24000,
                });
              }
            },
            audio: (pcm, rate) => {
              if (closed) return;
              if (
                !conversation?.valid() ||
                rate !== 24000 ||
                client.bufferedAmount > 128000
              )
                return fail('实时语音连接已失效或网络拥堵。');
              client.send(pcm, { binary: true });
            },
            interrupted: () => {
              flushTranscript();
              send({ type: 'interrupted' });
            },
            transcript: (speaker, text, timing) => {
              if (speaker === 'human') {
                heard = (heard + text).slice(-4000);
                if (timing)
                  fragments = [...fragments, { text, ...timing }].slice(-500);
                const owner = this.actorSessions
                  .get(conversation!.actorId)
                  ?.values()
                  .next().value;
                if (owner === conversation!.agentId) {
                  humanSpoken += text;
                  if (humanSpoken.length >= 2000) flushHumanTranscript();
                  else {
                    clearTimeout(humanTranscriptTimer);
                    humanTranscriptTimer = setTimeout(
                      flushHumanTranscript,
                      2000,
                    );
                  }
                }
              } else {
                spoken += text;
                if (spoken.length >= 2000) flushTranscript();
                else {
                  clearTimeout(transcriptTimer);
                  transcriptTimer = setTimeout(flushTranscript, 2000);
                }
              }
              send({ type: 'transcript', speaker, text });
            },
            transcriptEnd: flushTranscript,
            delegation: (id, request, offsetMs) => {
              if (closed || seenDelegations.has(id)) return;
              if (seenDelegations.size >= 1000)
                return fail('实时语音请求过多，请重新开始对话。');
              seenDelegations.add(id);
              if (pending.size) {
                session?.deliverDelegation(
                  id,
                  'Agent 正在处理前一个请求，请稍候。',
                );
                return;
              }
              const recent =
                offsetMs === undefined
                  ? ''
                  : fragments
                      .filter(
                        (part) =>
                          part.endMs > offsetMs - 12000 &&
                          part.startMs <= offsetMs,
                      )
                      .map((part) => part.text)
                      .join('');
              const text = (
                request ??
                (offsetMs !== undefined && fragments.length ? recent : heard)
              ).trim();
              heard = '';
              if (offsetMs !== undefined)
                fragments = fragments.filter((part) => part.startMs > offsetMs);
              if (!text || text.length > 240) {
                session?.deliverDelegation(
                  id,
                  '请求为空或过长，请玩家分成简短的请求。',
                );
                return;
              }
              const controller = new AbortController();
              pending.set(id, controller);
              void conversation!
                .delegate(text, controller.signal)
                .then((result) => {
                  if (!closed && !controller.signal.aborted)
                    session?.deliverDelegation(id, result);
                })
                .catch(() => {
                  if (!closed && !controller.signal.aborted)
                    session?.deliverDelegation(
                      id,
                      'Agent 未能完成该请求，请稍后重试。',
                    );
                })
                .finally(() => {
                  if (pending.get(id) === controller) pending.delete(id);
                });
            },
            cancelDelegation: (id) => {
              pending.get(id)?.abort();
              pending.delete(id);
            },
            error: fail,
            closed: cleanup,
          };
          const options = {
            apiKey: lease.settings.apiKey,
            model: lease.settings.model,
            voice: lease.settings.voice,
            instructions: conversation.instructions,
            events,
          };
          session = this.factory(lease.settings, options);
          monitor = setInterval(() => {
            if (!conversation?.valid()) fail('玩家或 Agent 已离开对话范围。');
          }, 1000);
          lifetime = setTimeout(
            () => fail('实时语音已达到时长上限，请重新开始。'),
            300000,
          );
        } catch (error) {
          fail(
            error instanceof AppError
              ? error.message
              : '无法启动实时语音，请检查服务配置。',
          );
        }
        return;
      }
      if (!ready || !conversation?.valid())
        return fail('实时语音尚未就绪或对话已失效。');
      if (!binary) {
        try {
          if (JSON.parse(data.toString()).type !== 'stop') throw Error();
          cleanup();
        } catch {
          fail('无效的实时语音指令。');
        }
        return;
      }
      const pcm = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);
      bytesSent += pcm.length;
      if (
        !pcm.length ||
        pcm.length > 3200 ||
        pcm.length % 2 ||
        bytesSent > (Date.now() - begunAt) * 32 + 64000
      )
        return fail('实时语音音频格式或发送速率无效。');
      session?.sendAudio(
        session.inputSampleRate === 24000 ? converter.convert(pcm) : pcm,
      );
    });
  };
  close() {
    for (const client of this.clients) client.close();
  }
}
