import { expect, it, vi } from 'vitest';
import { createSpatialSignaling } from './spatial-signaling.service';

function fixture() {
  const players = new Map(
    ['a', 'b'].map((id) => [
      id,
      {
        id,
        kind: 'human',
        connected: true,
        voiceSending: false,
        voiceListening: true,
      },
    ]),
  );
  const send = vi.fn();
  return {
    players,
    send,
    relay: createSpatialSignaling((id) => players.get(id), send),
  };
}

it('relays only sanitized descriptions and candidates with the actual sender identity', () => {
  const { relay, send } = fixture();
  relay('a', {
    to: 'b',
    from: 'spoof',
    description: { type: 'offer', sdp: 'fixture', extra: 'private' },
  });
  expect(send).toHaveBeenLastCalledWith('b', {
    from: 'a',
    description: { type: 'offer', sdp: 'fixture' },
  });
  relay('a', {
    to: 'b',
    candidate: {
      candidate: 'ice',
      sdpMid: null,
      sdpMLineIndex: null,
      extra: 'private',
    },
  });
  expect(send).toHaveBeenLastCalledWith('b', {
    from: 'a',
    candidate: { candidate: 'ice', sdpMid: null, sdpMLineIndex: null },
  });
});

it.each(['a', 'b'])(
  'rejects signaling when participant %s is disconnected, nonhuman or opted out',
  (id) => {
    const { players, send, relay } = fixture();
    const player = players.get(id)!;
    const signal = { to: 'b', description: { type: 'offer', sdp: 'fixture' } };
    player.connected = false;
    relay('a', signal);
    player.connected = true;
    player.kind = 'ai-agent';
    relay('a', signal);
    player.kind = 'human';
    player.voiceListening = false;
    relay('a', signal);
    expect(send).not.toHaveBeenCalled();
    player.voiceSending = true;
    relay('a', signal);
    expect(send).toHaveBeenCalledOnce();
  },
);

it('preserves payload bounds, description precedence and silent rejection', () => {
  const { relay, send } = fixture();
  const candidate = { candidate: 'ice', sdpMid: '0', sdpMLineIndex: 0 };
  for (const payload of [
    undefined,
    { to: 'missing' },
    { to: 'a', candidate },
    { to: 'b', description: { type: 'rollback', sdp: '' } },
    { to: 'b', description: { type: 'offer', sdp: 'x'.repeat(12001) } },
    { to: 'b', candidate: { ...candidate, candidate: 'x'.repeat(2001) } },
    { to: 'b', candidate: { ...candidate, sdpMid: 'x'.repeat(100) } },
    { to: 'b', candidate: { ...candidate, sdpMLineIndex: 1.5 } },
  ])
    relay('a', payload);
  expect(send).not.toHaveBeenCalled();
  relay('a', {
    to: 'b',
    description: { type: 'answer', sdp: 'x'.repeat(12000) },
    candidate,
  });
  expect(send.mock.calls.at(-1)![1]).toHaveProperty('description');
  expect(send.mock.calls.at(-1)![1]).not.toHaveProperty('candidate');
  relay('a', {
    to: 'b',
    candidate: {
      ...candidate,
      candidate: 'x'.repeat(2000),
      sdpMid: 'x'.repeat(99),
    },
  });
  expect(send).toHaveBeenCalledTimes(2);
});
