import WebSocket from 'ws';
import type { AsrEvent, LiveAsrDraft } from '@voxel/shared';

export type OpenAIConnector = (key: string) => WebSocket;
export const connectOpenAI: OpenAIConnector = (key) =>
  new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
    headers: { Authorization: `Bearer ${key}` },
    handshakeTimeout: 10000,
    maxPayload: 256 * 1024,
  });

import { Pcm16Upsampler } from '../../../../core/audio/pcm-resample';

/** Bridge the 16 kHz client protocol to OpenAI transcription. */
export function bridgeOpenAIAsr(
  client: WebSocket,
  settings: Extract<LiveAsrDraft, { provider: 'openai' }>,
  language: string,
  connect: OpenAIConnector = connectOpenAI,
) {
  let upstream: WebSocket | undefined;
  let closed = false,
    ready = false,
    finishing = false,
    total = 0;
  let segmentBytes = 0,
    quietBytes = 0,
    heardVoice = false,
    pending = false;
  const partials = new Map<string, string>();
  const completed = new Set<string>();
  const earlyResults = new Map<string, string>();
  let pendingId: string | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const upsampler = new Pcm16Upsampler();
  const send = (event: AsrEvent) => {
    if (client.readyState === WebSocket.OPEN)
      client.send(JSON.stringify(event));
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    clearTimeout(lifetime);
    upstream?.terminate();
    client.close();
  };
  const fail = (message: string) => {
    if (!closed) {
      send({ type: 'error', message });
      cleanup();
    }
  };
  const finished = () => {
    if (!closed) {
      send({ type: 'finished' });
      cleanup();
    }
  };
  const sendUp = (message: object) => upstream?.send(JSON.stringify(message));
  const commit = () => {
    if (pending || segmentBytes < 4800) return false;
    pending = true;
    pendingId = undefined;
    segmentBytes = 0;
    quietBytes = 0;
    heardVoice = false;
    sendUp({ type: 'input_audio_buffer.commit' });
    clearTimeout(timeout);
    timeout = setTimeout(() => fail('确认识别结果超时，请重试。'), 15000);
    return true;
  };
  const finishOpenAI = () => {
    if (pending) return;
    if (segmentBytes > 0) {
      if (segmentBytes < 4800) {
        const padding = Buffer.alloc(4800 - segmentBytes);
        sendUp({
          type: 'input_audio_buffer.append',
          audio: upsampler.convert(padding).toString('base64'),
        });
        segmentBytes = 4800;
      }
      commit();
      return;
    }
    finished();
  };
  const finishOpenAIItem = (id: string, transcript: string) => {
    completed.add(id);
    earlyResults.clear();
    pending = false;
    pendingId = undefined;
    clearTimeout(timeout);
    partials.delete(id);
    send({ type: 'partial', text: '' });
    if (transcript.trim()) send({ type: 'final', text: transcript.trim() });
    const latest = Array.from(partials.values()).at(-1);
    if (latest) send({ type: 'partial', text: latest });
    if (finishing) finishOpenAI();
    else if (heardVoice && quietBytes >= 25600) commit();
  };
  timeout = setTimeout(() => fail('实时识别连接超时，请检查配置。'), 15000);
  const lifetime = setTimeout(
    () => fail('实时识别已达到 5 分钟上限，请重新开始。'),
    310000,
  );
  client.on('close', cleanup);
  client.on('error', cleanup);
  try {
    upstream = connect(settings.apiKey);
  } catch {
    fail('无法连接实时识别服务，请检查配置。');
    return cleanup;
  }
  upstream.on('error', () => fail('无法连接实时识别服务，请检查密钥和网络。'));
  upstream.on('unexpected-response', (_req, response) => {
    response.destroy();
    fail('实时识别连接失败，请检查密钥、模型权限和账户额度。');
  });
  upstream.on('close', () => {
    if (!closed) fail('实时识别连接已中断，未确认内容已取消。');
  });
  upstream.on('open', () => {
    sendUp({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: settings.model, languages: [language] },
            turn_detection: null,
          },
        },
      },
    });
  });
  upstream.on('message', (data, binary) => {
    if (closed) return;
    try {
      if (binary) throw Error('binary');
      const msg = JSON.parse(data.toString());
      if (msg.error || msg.type === 'error') {
        fail('实时识别失败，请检查密钥、模型权限和账户额度。');
        return;
      }
      if (!ready && msg.type === 'session.updated') {
        ready = true;
        clearTimeout(timeout);
        send({ type: 'ready' });
        return;
      }
      if (!ready) return;
      if (msg.type === 'input_audio_buffer.committed') {
        if (!pending || typeof msg.item_id !== 'string') throw Error('commit');
        const itemId: string = msg.item_id;
        pendingId = itemId;
        const early = earlyResults.get(itemId);
        if (early !== undefined) finishOpenAIItem(itemId, early);
      } else if (
        msg.type === 'conversation.item.input_audio_transcription.delta'
      ) {
        if (typeof msg.item_id !== 'string' || typeof msg.delta !== 'string')
          throw Error('delta');
        if (completed.has(msg.item_id)) return;
        const partial = (partials.get(msg.item_id) ?? '') + msg.delta;
        if (partial.length > 8000) throw Error('delta');
        partials.set(msg.item_id, partial);
        send({ type: 'partial', text: partial });
      } else if (
        msg.type === 'conversation.item.input_audio_transcription.completed'
      ) {
        if (
          typeof msg.item_id !== 'string' ||
          typeof msg.transcript !== 'string' ||
          msg.transcript.length > 8000
        )
          throw Error('transcript');
        if (completed.has(msg.item_id)) return;
        if (!pending) throw Error('unexpected completion');
        if (pendingId === msg.item_id)
          finishOpenAIItem(msg.item_id, msg.transcript);
        else if (!pendingId && earlyResults.size < 8)
          earlyResults.set(msg.item_id, msg.transcript);
      } else if (
        msg.type === 'conversation.item.input_audio_transcription.failed'
      )
        fail('语音转写失败，请重试。');
    } catch {
      fail('实时识别服务返回了无效响应。');
    }
  });
  client.on('message', (data, binary) => {
    if (closed) return;
    if (!ready || finishing) {
      fail('识别任务尚未就绪或已经结束。');
      return;
    }
    if (binary) {
      const bytes = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);
      total += bytes.length;
      if (
        !bytes.length ||
        bytes.length > 3200 ||
        bytes.length % 2 ||
        total > 16000 * 2 * 300
      ) {
        fail('音频格式或时长超出限制。');
        return;
      }
      if (
        !upstream ||
        upstream.bufferedAmount > 128000 ||
        client.bufferedAmount > 128000
      ) {
        fail('识别网络拥堵，请稍后重试。');
        return;
      }
      let energy = 0;
      for (let i = 0; i < bytes.length; i += 2) {
        const sample = bytes.readInt16LE(i);
        energy += sample * sample;
      }
      const voiced = Math.sqrt(energy / (bytes.length / 2)) >= 262;
      segmentBytes += bytes.length;
      if (voiced) {
        heardVoice = true;
        quietBytes = 0;
      } else quietBytes += bytes.length;
      sendUp({
        type: 'input_audio_buffer.append',
        audio: upsampler.convert(bytes).toString('base64'),
      });
      if ((heardVoice && quietBytes >= 25600) || segmentBytes >= 32000 * 20)
        commit();
    } else {
      try {
        if (JSON.parse(data.toString()).type !== 'finish')
          throw Error('command');
      } catch {
        fail('无效的实时识别指令。');
        return;
      }
      finishing = true;
      clearTimeout(timeout);
      timeout = setTimeout(() => fail('确认最后一句超时，请重试。'), 15000);
      finishOpenAI();
    }
  });
  return cleanup;
}
