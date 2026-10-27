import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { AsrEvent, BailianAsrDraft } from '@voxel/shared';
import { asrEndpoint } from '../../asr/asr-settings';

function handshakeFailure(status: number | undefined) {
  if (status === 401)
    return '阿里云识别认证失败（HTTP 401）。请在上方“更换密钥”中填写所选地域的有效 API Key，保存后重试。';
  if (status === 403)
    return '阿里云拒绝识别连接（HTTP 403）。请检查 API Key 的业务空间、地域和服务访问权限。';
  if (status === 429) return '阿里云识别请求过于频繁（HTTP 429），请稍后重试。';
  if (status && status >= 500) return '阿里云识别服务暂时不可用，请稍后重试。';
  return '阿里云识别握手失败，请检查服务地域、业务空间和接口配置。';
}

function connectionFailure(error: NodeJS.ErrnoException) {
  // Only map known codes. Provider text can contain credentials or request details.
  if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN')
    return '服务器无法解析阿里云识别地址，请检查服务器 DNS 和网络。';
  if (error.code === 'ETIMEDOUT')
    return '服务器连接阿里云识别超时，请检查服务器网络后重试。';
  if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET')
    return '服务器与阿里云识别的连接被拒绝或重置，请检查服务器网络后重试。';
  return '服务器连接阿里云识别失败，请检查服务器网络与 TLS 配置后重试。';
}

/** One browser recording owns one upstream task. Only task-started permits PCM. */
export function bridgeBailianAsr(
  client: WebSocket,
  settings: BailianAsrDraft,
  language: string,
  connect = (url: string, key: string) =>
    new WebSocket(url, {
      headers: { Authorization: `Bearer ${key}` },
      handshakeTimeout: 10000,
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
    }),
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
    // terminate also aborts an in-progress handshake, without leaving paid tasks running.
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
    upstream = connect(asrEndpoint(settings), settings.apiKey);
  } catch {
    fail('无法连接阿里云识别服务，请检查配置。');
    return cleanup;
  }
  upstream.on('error', (error: NodeJS.ErrnoException) =>
    fail(connectionFailure(error)),
  );
  upstream.on('unexpected-response', (_request, response) => {
    // Abort the rejected handshake; never expose or buffer the provider response body.
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
          // Never forward provider error text, which can contain credentials/request details.
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
