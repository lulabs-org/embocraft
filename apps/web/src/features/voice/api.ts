import { adminHeaders, getGatewayToken } from '../../network/gateway';
import type {
  AsrAssignments,
  AsrUse,
  AsrServiceDraft,
  AsrServiceView,
  SpeachesConnectionDraft,
  SpeachesModel,
} from '@voxel/shared';
import type { SpeechCapabilities } from '../../audio';
import { serverHttpUrl } from '../../network/endpoints';
import { managementRequest } from '@voxel/shared/management';

async function asrRequest<T>(
  path: string,
  method: string,
  signal: AbortSignal,
  draft?: AsrServiceDraft,
): Promise<T> {
  const response = await fetch(`${serverHttpUrl()}/voice/asr/services${path}`, {
    method,
    signal,
    headers: {
      ...adminHeaders(),
      ...(draft ? { 'Content-Type': 'application/json' } : {}),
    },
    body: draft ? JSON.stringify(draft) : undefined,
  });
  if (response.status === 204) return undefined as T;
  const value = await response.json();
  if (!response.ok) throw Error(value.error || '无法读取识别服务配置。');
  return value;
}

export const voiceApi = {
  speachesDefaults: (signal?: AbortSignal) =>
    managementRequest<{ baseUrl: string }>(
      `${serverHttpUrl()}/voice/asr/defaults`,
      { token: getGatewayToken(), signal },
    ),
  listSpeachesModels: (
    connection: SpeachesConnectionDraft,
    signal?: AbortSignal,
  ) =>
    managementRequest<{ models: SpeachesModel[] }>(
      `${serverHttpUrl()}/voice/asr/models`,
      {
        token: getGatewayToken(),
        method: 'POST',
        body: connection,
        signal,
      },
    ),
  async asrAssignments(signal: AbortSignal): Promise<AsrAssignments> {
    const response = await fetch(`${serverHttpUrl()}/voice/asr/assignments`, {
      signal,
    });
    if (!response.ok) throw Error('无法读取识别服务分配，请检查连接后重试。');
    return response.json();
  },
  async assignAsrService(
    use: AsrUse,
    serviceId: string,
    signal: AbortSignal,
  ): Promise<AsrAssignments> {
    const response = await fetch(
      `${serverHttpUrl()}/voice/asr/assignments/${use}`,
      {
        method: 'PUT',
        signal,
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId }),
      },
    );
    const value = await response.json();
    if (!response.ok) throw Error(value.error || '无法保存识别服务分配。');
    return value;
  },
  listAsrServices: (signal: AbortSignal) =>
    asrRequest<AsrServiceView[]>('', 'GET', signal),
  saveAsrService: (draft: AsrServiceDraft, signal: AbortSignal, id?: string) =>
    asrRequest<AsrServiceView>(
      id ? `/${encodeURIComponent(id)}` : '',
      id ? 'PUT' : 'POST',
      signal,
      draft,
    ),
  deleteAsrService: (id: string, signal: AbortSignal) =>
    asrRequest<void>(`/${encodeURIComponent(id)}`, 'DELETE', signal),
  async capabilities(
    signal: AbortSignal,
    serviceId?: string,
  ): Promise<SpeechCapabilities> {
    const response = await fetch(
      `${serverHttpUrl()}/voice/capabilities${serviceId ? `?serviceId=${encodeURIComponent(serviceId)}` : ''}`,
      {
        signal,
      },
    );
    if (!response.ok) throw Error('capabilities');
    const value = await response.json();
    if (typeof value.local?.available !== 'boolean')
      throw Error('capabilities');
    return value;
  },
};
