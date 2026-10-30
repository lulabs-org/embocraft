import { useEffect, useState } from 'react';
import type { AsrAssignments, AsrUse } from '@voxel/shared';
import { voiceApi } from './api';
import type { AsrChoice } from '../../audio/services/asr-choice';

export type { AsrUse } from '@voxel/shared';
const key = 'voxel.asr-selection.v2';
const event = 'voxel-asr-selection';
const unselectedAsrChoice: AsrChoice = {
  id: '',
  name: '',
  provider: 'whisper',
};

export function toAsrChoice(value: unknown): AsrChoice {
  if (!value || typeof value !== 'object') return unselectedAsrChoice;
  const choice = value as Partial<AsrChoice>;
  const provider = choice.provider ?? 'bailian';
  if (
    typeof choice.id !== 'string' ||
    !choice.id ||
    typeof choice.name !== 'string' ||
    !choice.name ||
    !['whisper', 'bailian', 'browser'].includes(provider)
  )
    return unselectedAsrChoice;
  return {
    id: choice.id,
    name: choice.name,
    provider,
    ...(typeof choice.language === 'string'
      ? { language: choice.language }
      : {}),
  };
}

const forUse = (use: AsrUse, value: unknown) => {
  const choice = toAsrChoice(value);
  return use === 'clip' && choice.provider !== 'whisper'
    ? unselectedAsrChoice
    : choice;
};

let volatileSelections: Record<AsrUse, AsrChoice> | undefined;
let loadError = '';
let loading = false;
let revision = 0;
let pending: Promise<void> | undefined;

function readSelections(): Record<AsrUse, AsrChoice> {
  if (volatileSelections) return volatileSelections;
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return {
      chat: toAsrChoice(value.chat),
      spatial: toAsrChoice(value.spatial),
      clip: forUse('clip', value.clip),
    };
  } catch {
    return {
      chat: unselectedAsrChoice,
      spatial: unselectedAsrChoice,
      clip: unselectedAsrChoice,
    };
  }
}

function writeSelections(value: Record<AsrUse, AsrChoice>) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    volatileSelections = undefined;
  } catch {
    // Server assignments must work even when browser storage is unavailable.
    volatileSelections = value;
  }
  window.dispatchEvent(new Event(event));
}

export function chooseAsrService(use: AsrUse, choice: AsrChoice) {
  writeSelections({ ...readSelections(), [use]: forUse(use, choice) });
}

function applyAssignments(assignments: AsrAssignments, replaceUse?: AsrUse) {
  const current = readSelections();
  for (const use of ['chat', 'spatial', 'clip'] as const) {
    if (use === replaceUse || current[use].provider !== 'browser')
      current[use] = forUse(use, assignments[use]);
  }
  writeSelections(current);
}

/** Load public routing metadata without entering or authenticating to the console. */
export function refreshAsrSelections(afterMutation = false): Promise<void> {
  if (pending)
    return afterMutation ? pending.then(() => refreshAsrSelections()) : pending;
  const started = revision;
  loading = true;
  loadError = '';
  window.dispatchEvent(new Event(event));
  pending = voiceApi
    .asrAssignments(AbortSignal.timeout(10000))
    .then((assignments) => {
      if (started === revision) applyAssignments(assignments);
    })
    .catch((error: unknown) => {
      if (started === revision)
        loadError =
          error instanceof Error ? error.message : '无法读取识别服务分配。';
    })
    .finally(() => {
      loading = false;
      pending = undefined;
      window.dispatchEvent(new Event(event));
    });
  return pending;
}

export function useAsrSelectionSync() {
  useEffect(() => {
    const refresh = () => {
      void refreshAsrSelections();
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
    };
  }, []);
}

export function syncAsrChoice(id: string, saved?: unknown) {
  if (!id) return;
  revision++;
  const choices = readSelections();
  const next = saved ? toAsrChoice(saved) : unselectedAsrChoice;
  if (
    choices.chat.id !== id &&
    choices.spatial.id !== id &&
    choices.clip.id !== id
  )
    return;
  if (choices.chat.id === id) choices.chat = next;
  if (choices.spatial.id === id) choices.spatial = next;
  if (choices.clip.id === id) choices.clip = forUse('clip', next);
  writeSelections(choices);
}

export function useAsrSelection(use: AsrUse) {
  const [selected, setSelected] = useState(() => readSelections()[use]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [remote, setRemote] = useState({ error: loadError, loading });
  useEffect(() => {
    const sync = () => {
      setSelected(readSelections()[use]);
      setRemote({ error: loadError, loading });
    };
    sync();
    window.addEventListener(event, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(event, sync);
      window.removeEventListener('storage', sync);
    };
  }, [use]);
  return {
    selected,
    error: error || remote.error,
    loading: remote.loading,
    saving,
    choose: async (choice: AsrChoice) => {
      setSaving(true);
      try {
        if (choice.provider === 'browser') {
          chooseAsrService(use, choice);
        } else {
          // Invalidate reads started before this write, including while it is in flight.
          revision++;
          const assignments = await voiceApi.assignAsrService(
            use,
            choice.id,
            AbortSignal.timeout(10000),
          );
          revision++;
          loadError = '';
          applyAssignments(assignments, use);
        }
        setError('');
        return true;
      } catch (error) {
        setError(
          error instanceof Error ? error.message : '无法保存识别服务分配。',
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
  };
}
