import { adminHeaders } from '../../../network/gateway';
import type {
  SpeachesConnectionDraft,
  SpeachesModel,
  VoiceServiceDraft,
  VoiceServiceView,
} from '@voxel/shared';
import { serverHttpUrl } from '../../../network/endpoints';
import { readAgentResponse } from '../agent-response';
import { consoleFetch } from '../request';

export const voiceApi = {
  speachesDefaults: (signal?: AbortSignal) =>
    consoleFetch<{ baseUrl: string }>('/voice/tts/defaults', { signal }),
  listSpeachesModels: (
    connection: SpeachesConnectionDraft,
    signal?: AbortSignal,
  ) =>
    consoleFetch<{ models: SpeachesModel[] }>('/voice/tts/models', {
      method: 'POST',
      body: connection,
      signal,
    }),
  listVoiceServices: (signal?: AbortSignal) =>
    consoleFetch<VoiceServiceView[]>('/voice/tts/services', { signal }),
  saveVoiceService: (draft: VoiceServiceDraft, id?: string) =>
    consoleFetch<VoiceServiceView>(
      id
        ? `/voice/tts/services/${encodeURIComponent(id)}`
        : '/voice/tts/services',
      {
        method: id ? 'PUT' : 'POST',
        body: draft,
      },
    ),
  deleteVoiceService: (id: string) =>
    consoleFetch<void>(`/voice/tts/services/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  previewVoice: async (id: string, text: string, signal: AbortSignal) => {
    const response = await fetch(
      `${serverHttpUrl()}/voice/tts/services/${encodeURIComponent(id)}/preview`,
      {
        method: 'POST',
        signal,
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      },
    );
    if (!response.ok) await readAgentResponse(response);
    if (!response.headers.get('content-type')?.startsWith('audio/wav'))
      throw Error('语音服务未返回可播放的音频。');
    return response.blob();
  },
};
