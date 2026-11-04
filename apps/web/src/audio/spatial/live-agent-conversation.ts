import type { Player } from '@voxel/shared';
import { serverSocketUrl } from '../../network/endpoints';
import { SpeechCapture } from '../recording/live-recorder';
import { LiveAgentPlayback } from './live-agent-playback';

type Link = {
  status: string;
  chatToken: string;
  self?: Player;
  players: Player[];
};
export type LiveConversationState = {
  status: 'idle' | 'connecting' | 'listening';
  error: string;
  humanText: string;
  agentText: string;
};
type AgentSession = {
  socket: WebSocket;
  playback: LiveAgentPlayback;
  ready: boolean;
  agentText: string;
};

/** One microphone feeds independent nearby Agent sessions. */
export class LiveAgentConversation {
  state: LiveConversationState = {
    status: 'idle',
    error: '',
    humanText: '',
    agentText: '',
  };
  private sessions = new Map<string, AgentSession>();
  private retryAfter = new Map<string, number>();
  private context?: AudioContext;
  private generation = 0;
  constructor(
    private readonly link: Link,
    private readonly changed: (state: LiveConversationState) => void,
    private readonly capture = new SpeechCapture(),
    private readonly connect = (url: string) => new WebSocket(url),
  ) {}
  private report(patch: Partial<LiveConversationState>) {
    this.state = { ...this.state, ...patch };
    this.changed({ ...this.state });
  }
  async start(stream: MediaStream, context: AudioContext) {
    this.stop();
    const generation = this.generation;
    if (this.link.status !== 'connected' || !this.link.chatToken) {
      this.report({ error: '请先连接世界。' });
      return;
    }
    this.context = context;
    this.report({
      status: 'connecting',
      error: '',
      humanText: '',
      agentText: '',
    });
    try {
      const started = await this.capture.start(
        (frame) => {
          if (generation !== this.generation) return;
          for (const [id, session] of this.sessions) {
            if (!session.ready || session.socket.readyState !== WebSocket.OPEN)
              continue;
            if (session.socket.bufferedAmount > 128000) {
              this.remove(id, '实时语音网络拥堵，请稍后重试。');
              continue;
            }
            session.socket.send(frame);
          }
        },
        () => this.fail('麦克风已中断。'),
        stream,
      );
      if (started && generation === this.generation)
        this.report({ status: 'listening' });
    } catch {
      if (generation === this.generation) this.fail('无法接入麦克风。');
    }
  }
  /** Called after each authenticated discovery; newcomers join without another click. */
  updateAgents(agents: { id: string; name: string }[]) {
    if (!this.context || this.state.status === 'idle') return;
    const eligible = new Set(agents.map((agent) => agent.id));
    for (const id of this.sessions.keys())
      if (!eligible.has(id)) this.remove(id);
    for (const id of this.retryAfter.keys())
      if (!eligible.has(id)) this.retryAfter.delete(id);
    for (const agent of agents) {
      if (
        this.sessions.has(agent.id) ||
        (this.retryAfter.get(agent.id) ?? 0) > Date.now()
      )
        continue;
      this.openAgent(agent.id, agent.name, this.context);
    }
    this.update();
  }
  private openAgent(id: string, name: string, context: AudioContext) {
    const generation = this.generation;
    const socket = this.connect(`${serverSocketUrl()}/voice/live/session`);
    const session: AgentSession = {
      socket,
      playback: new LiveAgentPlayback(context),
      ready: false,
      agentText: '',
    };
    this.sessions.set(id, session);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: 'start',
          token: this.link.chatToken,
          agentId: id,
        }),
      );
    socket.onmessage = (event) => {
      if (generation !== this.generation || this.sessions.get(id) !== session)
        return;
      try {
        if (event.data instanceof ArrayBuffer) {
          this.update();
          session.playback.append(event.data, 24000);
          return;
        }
        const value = JSON.parse(event.data);
        if (value.type === 'ready') {
          if (session.ready) throw Error('duplicate ready');
          session.ready = true;
          this.report({ error: '' });
        } else if (value.type === 'interrupted') session.playback.interrupt();
        else if (
          value.type === 'transcript' &&
          typeof value.text === 'string'
        ) {
          if (
            value.speaker === 'human' &&
            this.sessions.keys().next().value === id
          )
            this.report({
              humanText: (this.state.humanText + value.text).slice(-500),
            });
          else if (value.speaker === 'agent') {
            session.agentText = (session.agentText + value.text).slice(-500);
            this.report({ agentText: `${name}: ${session.agentText}` });
          }
        } else if (value.type === 'error')
          this.remove(
            id,
            typeof value.message === 'string'
              ? value.message
              : '实时语音失败。',
          );
      } catch {
        this.remove(id, '实时语音响应无效。');
      }
    };
    socket.onerror = () => {
      if (generation === this.generation && this.sessions.get(id) === session)
        this.remove(id, '无法连接实时语音服务。');
    };
    socket.onclose = () => {
      if (generation === this.generation && this.sessions.get(id) === session)
        this.remove(id, '实时语音连接已中断。');
    };
  }
  update() {
    if (!this.context) return;
    const self = this.link.self;
    if (this.link.status !== 'connected' || !self)
      return this.fail('玩家已离开世界。');
    for (const [id, session] of this.sessions) {
      const agent = this.link.players.find(
        (player) => player.id === id && player.connected,
      );
      if (agent) session.playback.update(self, agent);
      else this.remove(id);
    }
  }
  private remove(id: string, error?: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (error) {
      this.retryAfter.set(id, Date.now() + 15000);
      const name = this.link.players.find((player) => player.id === id)?.name;
      this.report({ error: name ? `${name}：${error}` : error });
    }
    if (session.socket.readyState === WebSocket.OPEN)
      session.socket.send(JSON.stringify({ type: 'stop' }));
    session.socket.close();
    session.playback.dispose();
  }
  private fail(message: string) {
    this.stop();
    this.report({ error: message });
  }
  stop() {
    ++this.generation;
    this.capture.stop();
    for (const id of this.sessions.keys()) this.remove(id);
    this.retryAfter.clear();
    this.context = undefined;
    this.report({ status: 'idle' });
  }
}
