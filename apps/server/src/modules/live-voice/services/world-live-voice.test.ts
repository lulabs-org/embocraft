import { expect, it, vi } from 'vitest';
import type { AICharacterView, ChatData } from '@voxel/shared';
import type { WorldRoom } from '../../world';
import { authorizeWorldLiveVoice } from './world-live-voice';
function setup() {
  const player = {
    id: 'human',
    name: 'Player',
    kind: 'human',
    connected: true,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
  };
  const agent = {
    id: 'agent-session',
    name: 'Agent',
    kind: 'ai-agent',
    connected: true,
    x: 1,
    y: 0,
    z: 0,
    yaw: 0,
  };
  const character = {
    id: 'character',
    name: 'Agent',
    sessionId: agent.id,
    liveVoiceServiceId: 'voice',
    roleDescription: '友好',
    permissions: { chat: true, move: true, place: false, remove: false },
  } as AICharacterView;
  const listeners = new Set<(actor: string, data: ChatData) => boolean>();
  const send = vi.fn();
  const room = {
    state: {
      players: new Map([
        [player.id, player],
        [agent.id, agent],
      ]),
    },
    chat: {
      authenticate: (token: string) => {
        if (token !== 'valid') throw Error('invalid');
        return player.id;
      },
      send,
    },
    onLiveVoiceChat: (fn: (actor: string, data: ChatData) => boolean) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    publishLiveVoiceTranscript: vi.fn(),
  } as unknown as WorldRoom;
  return {
    room,
    player,
    agent,
    character,
    listeners,
    send,
    authorize: () =>
      authorizeWorldLiveVoice(
        () => room,
        () => [character],
        'valid',
        agent.id,
      ),
  };
}
it('requires a connected nearby human and enabled Agent and rechecks range', () => {
  const t = setup();
  const conversation = t.authorize();
  expect(conversation).toMatchObject({
    actorId: 'human',
    agentId: 'agent-session',
    serviceId: 'voice',
  });
  expect(conversation.instructions).toContain('友好');
  t.agent.x = 100;
  expect(conversation.valid()).toBe(false);
  expect(() => t.authorize()).toThrow('范围');
});
it('delegates to the actual Agent and returns only a private reply to that player', async () => {
  const t = setup(),
    conversation = t.authorize();
  const controller = new AbortController();
  const result = conversation.delegate('帮我建房', controller.signal);
  expect(t.send).toHaveBeenCalledWith('human', {
    scope: 'private',
    recipients: ['agent-session'],
    text: '帮我建房',
  });
  const listener = [...t.listeners][0];
  const reply = {
    scope: 'private',
    recipients: ['human'],
    name: 'Agent',
    kind: 'text',
    text: '我开始处理。',
  } as ChatData;
  expect(listener('other-agent', reply)).toBe(false);
  expect(listener('agent-session', reply)).toBe(true);
  await expect(result).resolves.toBe('我开始处理。');
  expect(t.listeners.size).toBe(0);
});
it('removes the listener when a conversation is cancelled', async () => {
  const t = setup(),
    conversation = t.authorize();
  const controller = new AbortController();
  const result = conversation.delegate('走过来', controller.signal);
  controller.abort();
  await expect(result).rejects.toThrow('conversation ended');
  expect(t.listeners.size).toBe(0);
});
