import WebSocket from 'ws';
import type { AsrEvent, LiveAsrDraft } from '@voxel/shared';

export type GeminiConnector = (key: string) => WebSocket;
export const connectGemini: GeminiConnector = (key) =>
  new WebSocket(
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`,
    { handshakeTimeout: 10000, maxPayload: 256 * 1024 },
  );

/** Bridge the 16 kHz client protocol to Gemini transcription. */
export function bridgeGeminiAsr(
  client: WebSocket,
  settings: Extract<LiveAsrDraft, { provider: 'gemini' }>,
  language: string,
  connect: GeminiConnector = connectGemini,
) {
  let upstream: WebSocket | undefined;
  let closed = false,
    ready = false,
    finishing = false,
    total = 0;
  let geminiInterim = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const send = (event: AsrEvent) => {
    if (client.readyState === WebSocket.OPEN)
      client.send(JSON.stringify(event));
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    clearTimeout(settle);
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
  const settleGemini = () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (geminiInterim) fail('确认最后一句超时，请重试。');
      else finished();
    }, 8000);
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
  upstream.on('close', (code, reason) => {
    if (closed) return;
    const detail = reason.toString();
    if (
      /api.?key.+(?:not valid|invalid|expired)|(?:invalid|expired).+api.?key/i.test(
        detail,
      )
    )
      fail('Gemini API Key 无效，请检查并重新保存密钥。');
    else if (code === 1008 || code === 1007)
      fail('Gemini 拒绝了实时识别请求，请检查模型权限、语言和账户配置。');
    else fail('实时识别连接已中断，未确认内容已取消。');
  });
  upstream.on('open', () => {
    sendUp({
      setup: {
        model: `models/${settings.model}`,
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: {
          languageCodes: [language === 'zh' ? 'cmn-Hans-CN' : 'en-US'],
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
      if (!ready && msg.setupComplete) {
        ready = true;
        clearTimeout(timeout);
        send({ type: 'ready' });
        return;
      }
      if (!ready) return;
      const content = msg.serverContent;
      if (content?.interimInputTranscription) {
        const text = content.interimInputTranscription.text;
        if (typeof text !== 'string' || text.length > 8000)
          throw Error('interim');
        geminiInterim = !!text;
        send({ type: 'partial', text });
      }
      if (content?.inputTranscription) {
        const text = content.inputTranscription.text;
        if (typeof text !== 'string' || text.length > 8000)
          throw Error('final');
        geminiInterim = false;
        send({ type: 'partial', text: '' });
        if (text.trim()) send({ type: 'final', text: text.trim() });
      }
      if (finishing && content) settleGemini();
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
      sendUp({
        realtimeInput: {
          audio: {
            data: bytes.toString('base64'),
            mimeType: 'audio/pcm;rate=16000',
          },
        },
      });
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
      sendUp({ realtimeInput: { audioStreamEnd: true } });
      settleGemini();
    }
  });
  return cleanup;
}
