import { useEffect, useState } from 'react';
import type { LiveVoiceView } from '@voxel/shared';
import { consoleFetch } from '../request';
export function useLiveVoiceServices(
  open: boolean,
  setError: (error: string) => void,
) {
  const [liveVoiceServices, setLiveVoiceServices] = useState<LiveVoiceView[]>(
    [],
  );
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void consoleFetch<LiveVoiceView[]>('/voice/live/services', {
      signal: abort.signal,
    })
      .then((values) => {
        if (!abort.signal.aborted) setLiveVoiceServices(values);
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setError(
            error instanceof Error ? error.message : '无法读取实时语音服务。',
          );
      });
    return () => abort.abort();
  }, [open, setError]);
  return { liveVoiceServices, setLiveVoiceServices };
}
