import { randomUUID } from 'node:crypto';
import {
  spatialMix,
  SPEECH_HEARING_THRESHOLD,
  type ChatData,
  type Player,
} from '@voxel/shared';
import { AppError } from '../../core/errors/app-error';

type SpeechTicket = {
  actor: string;
  recipients: string[];
  expires: number;
  controller: AbortController;
  claimed: boolean;
};

export class SpatialSpeech {
  private tickets = new Map<string, SpeechTicket>();

  constructor(
    private players: () => Iterable<Player>,
    private emit: (actor: string, data: ChatData) => void,
  ) {}

  private speaker(actor: string) {
    const p = [...this.players()].find(
      (p) =>
        p.id === actor && p.connected && p.kind === 'human' && p.voiceSending,
    );
    if (!p) throw new AppError('附近麦克风已关闭，转写已停止。', 409);
    return p;
  }

  private hearing(actor: string) {
    const speaker = this.speaker(actor);
    return [...this.players()]
      .filter(
        (p) =>
          p.id !== actor &&
          p.connected &&
          (p.kind !== 'human' || p.voiceListening) &&
          spatialMix(p, speaker).gain >= SPEECH_HEARING_THRESHOLD,
      )
      .map((p) => p.id);
  }

  begin(actor: string) {
    this.prune();
    const recipients = this.hearing(actor);
    if ([...this.tickets.values()].filter((t) => t.actor === actor).length >= 4)
      throw new AppError('转写队列已满，请稍候。', 429);
    const id = randomUUID();
    this.tickets.set(id, {
      actor,
      recipients,
      expires: Date.now() + 45000,
      controller: new AbortController(),
      claimed: false,
    });
    return id;
  }

  claim(actor: string, id: string) {
    const signal = this.preview(actor, id);
    this.tickets.get(id)!.claimed = true;
    return signal;
  }

  /** Authorize a preview without consuming the ticket or emitting a chat event. */
  preview(actor: string, id: string) {
    this.prune();
    this.speaker(actor);
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.actor !== actor || ticket.claimed)
      throw new AppError('该语音片段已过期或处理过。', 409);
    return ticket.controller.signal;
  }

  publish(actor: string, id: string, text: string) {
    this.prune();
    const ticket = this.tickets.get(id);
    if (
      !ticket ||
      ticket.actor !== actor ||
      !ticket.claimed ||
      ticket.controller.signal.aborted
    )
      throw new AppError('语音片段已取消。', 409);
    const current = new Set(this.hearing(actor));
    const recipients = ticket.recipients.filter((id) => current.has(id));
    if (!text.trim() || text.length > 240)
      throw new AppError('识别结果为空或过长。');
    const data: ChatData = {
      scope: 'nearby',
      recipients,
      kind: 'text',
      name: this.speaker(actor).name,
      text,
      transcriptAvailable: true,
    };
    this.tickets.delete(id);
    this.emit(actor, data);
    return data;
  }

  end(actor: string, id: string) {
    const ticket = this.tickets.get(id);
    if (ticket?.actor === actor) {
      ticket.controller.abort();
      this.tickets.delete(id);
    }
  }

  cancel(actor: string) {
    for (const [id, ticket] of this.tickets)
      if (ticket.actor === actor) this.end(actor, id);
  }

  private prune() {
    for (const [id, ticket] of this.tickets)
      if (ticket.expires <= Date.now()) this.end(ticket.actor, id);
  }

  clear() {
    for (const ticket of this.tickets.values()) ticket.controller.abort();
    this.tickets.clear();
  }
}
