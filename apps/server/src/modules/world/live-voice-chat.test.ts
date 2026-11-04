import { expect, it, vi } from 'vitest';
import type { Client } from '@colyseus/core';
import { WorldRoom } from './world.room';
import { Avatar, WorldState } from './world.schema';

it('delivers live spoken text only to the participant without restarting speech or consuming agent task replies', () => {
  const room = new WorldRoom();
  room.setState(new WorldState());
  for (const [id, name] of [
    ['agent', 'AI'],
    ['human', 'Player'],
    ['other', 'Other'],
  ]) {
    const player = new Avatar();
    player.id = id;
    player.name = name;
    player.connected = true;
    room.state.players.set(id, player);
  }
  const client = (sessionId: string) => ({ sessionId, send: vi.fn() });
  const agent = client('agent'),
    human = client('human'),
    other = client('other');
  room.clients.push(
    agent as unknown as Client,
    human as unknown as Client,
    other as unknown as Client,
  );
  const enqueue = vi.spyOn(room.agentSpeech, 'enqueue');
  const taskListener = vi.fn(() => true);
  room.onLiveVoiceChat(taskListener);
  room.publishLiveVoiceTranscript('agent', 'human', '你好');
  expect(human.send).toHaveBeenCalledWith(
    'event',
    expect.objectContaining({
      type: 'chat',
      actor: 'agent',
      data: expect.objectContaining({
        name: 'AI',
        text: '你好',
        scope: 'private',
        recipients: ['human'],
      }),
    }),
  );
  expect(other.send).not.toHaveBeenCalled();
  expect(taskListener).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
  human.send.mockClear();
  agent.send.mockClear();
  room.publishLiveVoiceTranscript('human', 'human', '我说的话');
  expect(human.send).toHaveBeenCalledWith(
    'event',
    expect.objectContaining({
      actor: 'human',
      data: expect.objectContaining({
        name: 'Player',
        text: '我说的话',
        scope: 'nearby',
        recipients: [],
      }),
    }),
  );
  expect(agent.send).not.toHaveBeenCalled();
  expect(other.send).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});
