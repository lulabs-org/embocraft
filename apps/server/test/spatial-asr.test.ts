import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import type { Player } from '@voxel/shared';
import { LocalSpeech } from '../src/modules/asr/services/local-speech.service';
import { WorldChat } from '../src/modules/chat/services/chat.service';
import { installChatRoutes } from '../src/modules/chat/routes/chats.routes';
import { TestAsrSettingsStore } from './helpers/memory-storage';
import {
  pcmWav,
  speechTransport,
} from '../../web/src/audio/services/live-speech';
import {
  SpatialTranscriber,
  type TranscriptionState,
} from '../../web/src/audio/spatial/spatial-transcriber';
import {
  LiveRecorder,
  type SpeechCapture,
} from '../../web/src/audio/recording/live-recorder';

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

it('keeps listening after rejected nearby speech, clears stale captions and publishes only the next valid final', async () => {
  const speaker: Player = {
    id: 'speaker',
    name: 'Speaker',
    kind: 'human',
    connected: true,
    voiceSending: true,
    x: 0,
    y: 2,
    z: 0,
    yaw: 0,
  };
  const emit = vi.fn();
  const chat = new WorldChat(() => [speaker], emit);
  const token = chat.issue(speaker.id);
  let rejected = false;
  const upstream = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== 'POST') return Response.json({});
    const form = init.body as FormData;
    expect(form.get('vad_filter')).toBe('true');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('temperature')).toBe('0');
    expect(form.get('prompt')).toBeNull();
    expect(form.get('language')).toBeNull();
    return Response.json(
      rejected
        ? {
            text: '用用音转写。',
            segments: [
              { text: '用用音转写。', avg_logprob: -2, no_speech_prob: 0.99 },
            ],
          }
        : {
            text: 'Tell me a story.',
            segments: [
              {
                text: 'Tell me a story.',
                avg_logprob: -0.2,
                no_speech_prob: 0.01,
              },
            ],
          },
    );
  });
  const app = express();
  installChatRoutes(
    app,
    () => chat,
    new LocalSpeech('http://asr.test/v1', upstream),
    undefined,
    'http://127.0.0.1:5173',
    new TestAsrSettingsStore(),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const responses: { path: string; status: number; code?: string }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    headers.set('Origin', 'http://127.0.0.1:5173');
    const response = await fetch(base + url.pathname + url.search, {
      ...init,
      headers,
    });
    const data = response.status === 204 ? {} : await response.clone().json();
    responses.push({
      path: url.pathname,
      status: response.status,
      code: data.code,
    });
    return response;
  };
  let feed!: (frame: Uint8Array) => void;
  const capture = {
    canRecord: true,
    start: async (callback: typeof feed) => {
      feed = callback;
      return true;
    },
    stop() {},
    finish: async () => {},
  };
  let state: TranscriptionState = {
    status: '',
    text: '',
    partial: '',
    error: '',
  };
  const transcriber = new SpatialTranscriber(
    () => token,
    (next) => {
      state = next;
    },
    request,
    new LiveRecorder(capture as unknown as SpeechCapture),
  );
  const pcm = new Uint8Array(3200);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < 1600; i++)
    view.setInt16(
      i * 2,
      Math.round(1000 * Math.sin((2 * Math.PI * 440 * i) / 16000)),
      true,
    );
  const sentence = () => {
    for (let i = 0; i < 6; i++) feed(pcm);
    for (let i = 0; i < 9; i++) feed(new Uint8Array(3200));
  };
  try {
    await transcriber.start({} as MediaStream);
    sentence();
    await vi.waitFor(() =>
      expect(state.text, JSON.stringify({ state, responses })).toBe(
        'Tell me a story.',
      ),
    );
    expect(emit).toHaveBeenCalledTimes(1);
    rejected = true;
    sentence();
    await vi.waitFor(() =>
      expect(
        responses.some((r) => r.status === 400 && r.code === 'no-speech'),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(state.status).toContain('没有识别到清晰讲话'),
    );
    expect(state.text).toBe('');
    expect(state.partial).toBe('');
    expect(state.error).toBe('');
    expect(emit).toHaveBeenCalledTimes(1);
    rejected = false;
    sentence();
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));
    expect(
      emit.mock.calls.every(([, data]) => data.text === 'Tell me a story.'),
    ).toBe(true);
  } finally {
    transcriber.stop();
    chat.clear();
  }
});

it.each(['auto', 'en-US', 'zh-CN'])(
  'forwards the chosen nearby language for previews and final requests: %s',
  async (language) => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ text: 'hello' }),
    );
    const transport = speechTransport(language, () => 'token', request);
    for (const partial of [true, false])
      await transport.recognize(
        'ticket',
        pcmWav([new Uint8Array(3200)]),
        partial,
        new AbortController().signal,
      );
    const expected = language === 'auto' ? 'auto' : language.slice(0, 2);
    for (const [url] of request.mock.calls)
      expect(new URL(String(url)).searchParams.get('language')).toBe(expected);
  },
);
