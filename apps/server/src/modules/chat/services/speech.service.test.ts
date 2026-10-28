import type { Player } from '@voxel/shared';
import { DEFAULT_WHISPER_ASR } from '@voxel/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  TestAsrSettingsStore as AsrSettingsStore,
  TestAsrSettingsStore,
} from '../../../../test/helpers/memory-storage';
import type { LocalSpeech } from '../../audio';
import { WorldChat } from './chat.service';
import { ChatSpeechService } from './speech.service';

const player = (id: string): Player => ({
  id,
  name: id,
  kind: 'human',
  connected: true,
  voiceSending: true,
  x: 0,
  y: 2,
  z: 0,
  yaw: 0,
});

function setup() {
  const emit = vi.fn();
  const chat = new WorldChat(() => [player('actor')], emit);
  const token = chat.issue('actor');
  const bytes = Buffer.from('audio');
  const normalize = vi.fn().mockResolvedValue({ bytes, durationMs: 1000 });
  const transcribe = vi.fn().mockResolvedValue('hello');
  const speech = { normalize, transcribe } as unknown as LocalSpeech;
  return {
    chat,
    token,
    bytes,
    emit,
    normalize,
    transcribe,
    speech,
    service: new ChatSpeechService(speech, new TestAsrSettingsStore()),
  };
}

describe('chat speech coordination', () => {
  it('publishes audio without a transcript when ASR fails and releases the upload slot', async () => {
    const { chat, token, bytes, emit, transcribe, service } = setup();
    transcribe.mockRejectedValue(new Error('ASR unavailable'));
    const data = await service.publishAudio({
      chat,
      actor: 'actor',
      route: { scope: 'public', recipients: [] },
      bytes,
      contentType: 'audio/wav',
      language: 'en',
      token,
      signal: new AbortController().signal,
    });
    expect(data.transcriptAvailable).toBe(false);
    expect(emit).toHaveBeenCalledOnce();
    expect(() => chat.beginUpload('actor', {})).not.toThrow();
    chat.endUpload('actor');
  });

  it('does not publish audio after its chat token is rotated', async () => {
    const { chat, token, bytes, emit, transcribe, service } = setup();
    transcribe.mockImplementation(async () => {
      chat.issue('actor');
      return 'hello';
    });
    await expect(
      service.publishAudio({
        chat,
        actor: 'actor',
        route: { scope: 'public', recipients: [] },
        bytes,
        contentType: 'audio/wav',
        language: 'zh',
        token,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(emit).not.toHaveBeenCalled();
    expect(() => chat.beginUpload('actor', {})).not.toThrow();
    chat.endUpload('actor');
  });

  it('keeps previews unpublished and consumes the final spatial ticket', async () => {
    const { chat, token, bytes, emit, service } = setup();
    const id = chat.beginSpatial('actor');
    const input = {
      chat,
      actor: 'actor',
      id,
      bytes,
      contentType: 'audio/wav',
      token,
      signal: new AbortController().signal,
    };
    await expect(
      service.transcribeSpatial({ ...input, partial: true }),
    ).resolves.toEqual({
      text: 'hello',
    });
    expect(emit).not.toHaveBeenCalled();
    await expect(
      service.transcribeSpatial({ ...input, partial: false }),
    ).resolves.toMatchObject({ scope: 'nearby', text: 'hello' });
    expect(emit).toHaveBeenCalledOnce();
    expect(() => chat.claimSpatial('actor', id)).toThrow();
  });

  it('uses and releases the selected Whisper profile for nearby transcription', async () => {
    const { chat, token, bytes, transcribe, speech } = setup();
    const release = vi.fn();
    const settings = {
      ...DEFAULT_WHISPER_ASR,
      id: 'selected',
      name: 'Selected Whisper',
      provider: 'whisper' as const,
    };
    const store = {
      acquire: vi.fn(() => ({ settings, release })),
    } as unknown as AsrSettingsStore;
    const service = new ChatSpeechService(speech, store);
    const id = chat.beginSpatial('actor');
    await service.transcribeSpatial({
      chat,
      actor: 'actor',
      id,
      bytes,
      contentType: 'audio/wav',
      partial: false,
      serviceId: 'selected',
      token,
      signal: new AbortController().signal,
    });
    expect(store.acquire).toHaveBeenCalledWith('selected');
    expect(transcribe).toHaveBeenCalledWith(
      bytes,
      'audio/wav',
      'zh',
      expect.any(AbortSignal),
      settings,
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('uses and releases the selected Whisper profile for recorded chat audio', async () => {
    const { chat, token, bytes, transcribe, speech } = setup();
    const release = vi.fn();
    const settings = {
      ...DEFAULT_WHISPER_ASR,
      id: 'recording-whisper',
      name: 'Recording Whisper',
      provider: 'whisper' as const,
    };
    const store = {
      acquire: vi.fn(() => ({ settings, release })),
    } as unknown as AsrSettingsStore;
    const service = new ChatSpeechService(speech, store);
    const data = await service.publishAudio({
      chat,
      actor: 'actor',
      route: { scope: 'public', recipients: [] },
      bytes,
      contentType: 'audio/wav',
      language: 'zh',
      serviceId: 'recording-whisper',
      token,
      signal: new AbortController().signal,
    });
    expect(data.transcriptAvailable).toBe(true);
    expect(store.acquire).toHaveBeenCalledWith('recording-whisper');
    expect(transcribe).toHaveBeenCalledWith(
      bytes,
      'audio/wav',
      'zh',
      expect.any(AbortSignal),
      settings,
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
