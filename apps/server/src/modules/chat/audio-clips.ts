import { randomUUID } from 'node:crypto';
import { type ChatData, type Player, type WorldEvent } from '@voxel/shared';
import { AppError } from '../../common/errors';
import { visibleEvent } from './visibility';

type Clip = { bytes: Buffer; actor: string; data: ChatData; expires: number };
type ChatRoute = Pick<ChatData, 'scope' | 'recipients'>;

export class ChatAudioClips {
  private clips = new Map<string, Clip>();
  private uploads = new Set<string>();

  constructor(
    private players: () => Iterable<Player>,
    private route: (actor: string, value: unknown) => ChatRoute,
    private emit: (actor: string, data: ChatData) => void,
  ) {}

  beginUpload(actor: string, value: unknown) {
    this.route(actor, value);
    if (this.uploads.has(actor))
      throw new AppError('上一段语音仍在处理中。', 429);
    this.uploads.add(actor);
  }

  endUpload(actor: string) {
    this.uploads.delete(actor);
  }

  publishAudio(
    actor: string,
    value: unknown,
    bytes: Buffer,
    durationMs: number,
    text: string,
  ) {
    const route = this.route(actor, value);
    this.prune();
    while (
      this.clips.size >= 100 ||
      [...this.clips.values()].reduce((n, c) => n + c.bytes.length, 0) +
        bytes.length >
        32 * 1024 * 1024
    )
      this.clips.delete(this.clips.keys().next().value!);
    const audioId = randomUUID(),
      data: ChatData = {
        ...route,
        name: [...this.players()].find((p) => p.id === actor)!.name,
        kind: 'audio',
        audioId,
        durationMs,
        text: text || '[语音消息：暂无文字转写]',
        transcriptAvailable: !!text,
      };
    this.clips.set(audioId, {
      bytes,
      actor,
      data,
      expires: Date.now() + 10 * 60 * 1000,
    });
    this.emit(actor, data);
    return data;
  }

  audio(id: string, viewer: string) {
    this.prune();
    const clip = this.clips.get(id);
    if (
      !clip ||
      !visibleEvent(
        { type: 'chat', actor: clip.actor, data: clip.data } as WorldEvent,
        viewer,
      )
    )
      throw new AppError('语音已过期或不可访问。', 404);
    return clip.bytes;
  }

  private prune() {
    for (const [id, c] of this.clips)
      if (c.expires < Date.now()) this.clips.delete(id);
  }

  clear() {
    this.clips.clear();
    this.uploads.clear();
  }
}
