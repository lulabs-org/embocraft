import { env } from '../../core/config/env';
import { BailianSession, type BailianConfig } from './bailian-session';
import { DemoSocket } from './demo-socket';
import type { SceneAccess } from './scene-tools';
import type { RealtimeEvent } from '@voxel/shared/communication';
export class RealtimeHub {
  private sessions = new Map<string, BailianSession>();
  private requests = new Map<string, string>();
  constructor(
    private scene: (owner: string) => SceneAccess,
    private emit: (owner: string, event: RealtimeEvent) => void,
    private config: () => BailianConfig = () => env.readRealtime(),
  ) {}
  handle(
    owner: string,
    type: string,
    payload:
      | {
          mode?: unknown;
          request?: unknown;
          audioConsent?: unknown;
          sceneConsent?: unknown;
          session?: unknown;
          audio?: unknown;
          text?: unknown;
        }
      | null
      | undefined,
  ) {
    if (type === 'realtime.start') {
      if (payload?.mode !== 'demo' && payload?.mode !== 'real')
        throw Error('invalid-realtime-mode');
      if (
        typeof payload.request !== 'string' ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(payload.request)
      )
        throw Error('invalid-realtime-request');
      const request = payload.request;
      const demo = payload.mode === 'demo';
      if (!demo && payload.audioConsent !== true)
        throw Error('explicit-audio-consent-required');
      this.close(owner);
      const session = new BailianSession(
        demo,
        payload.sceneConsent === true ? this.scene(owner) : undefined,
        (event) => this.emit(owner, { ...event, request }),
      );
      this.sessions.set(owner, session);
      this.requests.set(owner, payload.request);
      try {
        session.start(
          demo
            ? { enabled: false, workspace: 'offline', credential: () => '' }
            : this.config(),
          demo ? () => new DemoSocket() : undefined,
        );
      } catch (error) {
        this.close(owner);
        throw error;
      }
      return;
    }
    const session = this.sessions.get(owner);
    if (
      type === 'realtime.stop' &&
      session &&
      typeof payload?.request === 'string' &&
      this.requests.get(owner) === payload.request
    ) {
      this.close(owner);
      return;
    }
    if (!session || payload?.session !== session.id)
      throw Error('invalid-realtime-session');
    if (type === 'realtime.audio') session.audio(payload.audio);
    else if (type === 'realtime.commit') session.commit(payload.text);
    else if (type === 'realtime.stop') this.close(owner);
    else throw Error('unknown-realtime-action');
  }
  approve(
    owner: string,
    payload: { session?: unknown; proposalId?: unknown } | null | undefined,
  ) {
    const session = this.sessions.get(owner);
    if (!session || session.id !== payload?.session)
      throw Error('invalid-realtime-session');
    return session.takeProposal(payload.proposalId);
  }
  close(owner: string) {
    this.sessions.get(owner)?.close();
    this.sessions.delete(owner);
    this.requests.delete(owner);
  }
  dispose() {
    for (const owner of this.sessions.keys()) this.close(owner);
  }
}
