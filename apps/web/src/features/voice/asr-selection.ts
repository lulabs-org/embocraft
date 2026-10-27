import { useEffect, useState } from 'react';
import type { AsrChoice } from '../../audio/services/asr-choice';

export type AsrUse = 'chat' | 'spatial' | 'clip';
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

function readSelections(): Record<AsrUse, AsrChoice> {
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
  localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new Event(event));
}

export function chooseAsrService(use: AsrUse, choice: AsrChoice) {
  writeSelections({ ...readSelections(), [use]: forUse(use, choice) });
}

/** Fill only unset uses after the saved service list reveals its actual ID. */
export function initializeAsrSelections(services: readonly AsrChoice[]) {
  const whisper = services.find(
    (service) =>
      service.id &&
      service.provider === 'whisper' &&
      service.name === '自托管 Whisper',
  );
  if (!whisper) return;
  const current = readSelections();
  if (current.chat.id && current.spatial.id && current.clip.id) return;
  const selected = toAsrChoice(whisper);
  try {
    writeSelections({
      chat: current.chat.id ? current.chat : selected,
      spatial: current.spatial.id ? current.spatial : selected,
      clip: current.clip.id ? current.clip : selected,
    });
  } catch {
    // Browsers that block preference storage can still use explicit choices.
  }
}

export function syncAsrChoice(id: string, saved?: unknown) {
  if (!id) return;
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
  try {
    writeSelections(choices);
  } catch {
    // A blocked preference store must not turn a successful service edit into a failure.
  }
}

export function useAsrSelection(use: AsrUse) {
  const [selected, setSelected] = useState(() => readSelections()[use]);
  const [error, setError] = useState('');
  useEffect(() => {
    const sync = () => setSelected(readSelections()[use]);
    window.addEventListener(event, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(event, sync);
      window.removeEventListener('storage', sync);
    };
  }, [use]);
  return {
    selected,
    error,
    choose: (choice: AsrChoice) => {
      try {
        chooseAsrService(use, choice);
        setError('');
      } catch {
        setError('无法保存识别服务选择，请检查浏览器存储设置。');
      }
    },
  };
}
