import type { AICharacterLogPage, AICharacterSettings } from '@voxel/shared';
import type { PublicAICharacterView } from '@voxel/shared/management';
import { consoleFetch } from '../request';

export const aiCharactersApi = {
  listAgents: (signal?: AbortSignal) =>
    consoleFetch<PublicAICharacterView[]>('/ai-characters', { signal }),
  saveAgent: (
    settings: Partial<AICharacterSettings> & {
      joinWorld?: boolean;
    },
    id?: string,
  ) =>
    consoleFetch<PublicAICharacterView>(
      id ? `/ai-characters/${encodeURIComponent(id)}` : '/ai-characters',
      {
        method: id ? 'PUT' : 'POST',
        body: settings,
      },
    ),
  getLogs: (id: string, cursor?: string, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    const query = params.toString();
    return consoleFetch<AICharacterLogPage>(
      `/ai-characters/${encodeURIComponent(id)}/logs${query ? `?${query}` : ''}`,
      { signal },
    );
  },
  joinAgent: (id: string) =>
    consoleFetch<void>(`/ai-characters/${encodeURIComponent(id)}/join`, {
      method: 'POST',
      body: {},
    }),
  stopAgent: (id: string) =>
    consoleFetch<void>(`/ai-characters/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
      body: {},
    }),
  deleteAgent: (id: string) =>
    consoleFetch<void>(`/ai-characters/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  setVoiceReplies: (id: string, enabled: boolean) =>
    consoleFetch<PublicAICharacterView>(
      `/ai-characters/${encodeURIComponent(id)}/voice`,
      {
        method: 'POST',
        body: { enabled },
      },
    ),
};
