type Participant = {
  id: string;
  kind: string;
  connected: boolean;
  voiceSending: boolean;
  voiceListening: boolean;
};

type Signal = {
  from: string;
  description?: { type: string; sdp: string };
  candidate?: {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
  };
};

/** Validates and relays signaling only; media stays between participating browsers. */
export function createSpatialSignaling(
  player: (id: string) => Participant | undefined,
  send: (recipient: string, signal: Signal) => void,
) {
  return (
    owner: string,
    payload:
      | {
          [key: string]: unknown;
          to?: string;
          description?: Record<string, unknown>;
          candidate?: Record<string, unknown>;
        }
      | null
      | undefined,
  ) => {
    const source = player(owner),
      target = payload?.to === undefined ? undefined : player(payload.to);
    if (
      !source?.connected ||
      !target?.connected ||
      source.id === target.id ||
      source.kind !== 'human' ||
      target.kind !== 'human' ||
      !(source.voiceSending || source.voiceListening) ||
      !(target.voiceSending || target.voiceListening)
    )
      return;
    const description = payload?.description,
      candidate = payload?.candidate;
    if (
      description &&
      typeof description.type === 'string' &&
      ['offer', 'answer'].includes(description.type) &&
      typeof description.sdp === 'string' &&
      description.sdp.length <= 12000
    )
      send(target.id, {
        from: source.id,
        description: { type: description.type, sdp: description.sdp },
      });
    else if (
      candidate &&
      typeof candidate.candidate === 'string' &&
      candidate.candidate.length <= 2000 &&
      (candidate.sdpMid === null ||
        (typeof candidate.sdpMid === 'string' &&
          candidate.sdpMid.length < 100)) &&
      (candidate.sdpMLineIndex === null ||
        (typeof candidate.sdpMLineIndex === 'number' &&
          Number.isInteger(candidate.sdpMLineIndex)))
    )
      send(target.id, {
        from: source.id,
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        },
      });
  };
}
