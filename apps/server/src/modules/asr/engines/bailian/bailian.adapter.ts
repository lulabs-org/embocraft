import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { AsrEvent, BailianAsrDraft } from '@voxel/shared';
import type { StreamingAsrPort } from '../../ports';
import {
  bailianAsrEndpoint,
  connectionFailure,
  handshakeFailure,
} from './bailian.endpoint';

export type BailianWsConnector = (url: string, key: string) => WebSocket;

export const defaultBailianConnector: BailianWsConnector = (url, key) =>
  new WebSocket(url, {
    headers: { Authorization: `Bearer ${key}` },
    handshakeTimeout: 10000,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
  });

/**
 * 桥接客户端与阿里云百炼 WebSocket 识别任务
 */
export function bridgeBailianAsr(
  client: WebSocket,
  settings: BailianAsrDraft,
  language: string,
  connect: BailianWsConnector = defaultBailianConnector,
) {
  const taskId = randomUUID();
  let upstream: WebSocket;
  let started = false,
    finishing = false,
    closed = false,
    total = 0;
  const finals = new Set<string>();

  const send = (event: AsrEvent) => {
    if (client.readyState === WebSocket.OPEN)
      client.send(JSON.stringify(event));
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    clearTimeout(lifetime);
    // 终止可能仍在握手的连接，防止任务在云端空转扣费
    upstream?.terminate();
    client.close();
  };

  const fail = (message: string) => {
    if (!closed) {
      send({ type: 'error', message });
      cleanup();
    }
  };

  let deadline = setTimeout(
    () => fail('阿里云识别连接超时，请检查配置后重试。'),
    15000,
  );
  const lifetime = setTimeout(
    () => fail('实时识别已达到 5 分钟上限，请重新开始。'),
    310000,
  );

  client.on('close', cleanup);
  client.on('error', cleanup);

  try {
    upstream = connect(bailianAsrEndpoint(settings), settings.apiKey);
  } catch {
    fail('无法连接阿里云识别服务，请检查配置。');
    return cleanup;
  }

  upstream.on('error', (error: NodeJS.ErrnoException) =>
    fail(connectionFailure(error)),
  );
  upstream.on('unexpected-response', (_request, response) => {
    fail(handshakeFailure(response.statusCode));
    response.destroy();
  });
  upstream.on('close', () => {
    if (!closed) fail('阿里云识别连接中断，未确认内容已取消。');
  });

  const header = (action: string) => ({
    action,
    task_id: taskId,
    streaming: 'duplex',
  });

  upstream.on('open', () => {
    if (closed) return;
    upstream.send(
      JSON.stringify({
        header: header('run-task'),
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: settings.model,
          parameters: {
            format: 'pcm',
            sample_rate: 16000,
            language_hints: [language],
            max_sentence_silence: 800,
            heartbeat: true,
          },
          input: {},
        },
      }),
    );
  });

  upstream.on('message', (data, binary) => {
    if (closed) return;
    try {
      if (binary) throw Error('binary');
      const message = JSON.parse(data.toString());
      if (message.header?.task_id !== taskId) throw Error('task');
      switch (message.header.event) {
        case 'task-started':
          if (started) break;
          started = true;
          clearTimeout(deadline);
          send({ type: 'ready' });
          break;
        case 'result-generated': {
          if (!started) throw Error('order');
          const sentence = message.payload?.output?.sentence;
          if (sentence?.heartbeat) break;
          if (
            typeof sentence?.text !== 'string' ||
            sentence.text.length > 8000 ||
            typeof sentence.sentence_end !== 'boolean'
          )
            throw Error('sentence');
          const text = sentence.text.trim();
          if (sentence.sentence_end) {
            const id = String(sentence.sentence_id ?? sentence.begin_time);
            if (id === 'undefined') throw Error('sentence id');
            if (!finals.has(id)) {
              finals.add(id);
              send({ type: 'partial', text: '' });
              if (text) send({ type: 'final', text });
            }
          } else send({ type: 'partial', text });
          break;
        }
        case 'task-finished':
          if (!finishing) throw Error('unexpected finish');
          send({ type: 'finished' });
          cleanup();
          break;
        case 'task-failed':
          fail('阿里云识别任务失败，请检查密钥、地域、模型权限和账户额度。');
          break;
        default:
          throw Error('event');
      }
    } catch {
      fail('阿里云返回了无效的识别响应，请重试。');
    }
  });

  client.on('message', (data, binary) => {
    if (closed) return;
    if (!started || finishing) {
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
      if (upstream.bufferedAmount > 128000 || client.bufferedAmount > 128000) {
        fail('识别网络拥堵，请稍后重试。');
        return;
      }
      upstream.send(bytes);
    } else {
      try {
        if (JSON.parse(data.toString()).type !== 'finish')
          throw Error('command');
        finishing = true;
        upstream.send(
          JSON.stringify({
            header: header('finish-task'),
            payload: { input: {} },
          }),
        );
        deadline = setTimeout(() => fail('确认最后一句超时，请重试。'), 15000);
      } catch {
        fail('无效的实时识别指令。');
      }
    }
  });

  return cleanup;
}

/**
 * 阿里云百炼实时识别适配器，实现 StreamingAsrPort
 */
export class BailianAdapter implements StreamingAsrPort {
  readonly provider = 'bailian' as const;

  constructor(
    private readonly connect: BailianWsConnector = defaultBailianConnector,
  ) {}

  bridge(
    client: WebSocket,
    settings: BailianAsrDraft,
    language: string,
  ): void {
    bridgeBailianAsr(client, settings, language, this.connect);
  }
}

