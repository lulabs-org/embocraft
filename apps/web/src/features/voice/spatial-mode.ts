import { useSyncExternalStore } from 'react';

export type SpatialVoiceMode = 'traditional' | 'live';
const key = 'voxel.spatial-voice-mode';
const event = 'voxel-spatial-voice-mode';
let fallback: SpatialVoiceMode | undefined;

export function readSpatialVoiceMode(): SpatialVoiceMode {
  if (fallback) return fallback;
  try {
    return localStorage.getItem(key) === 'live' ? 'live' : 'traditional';
  } catch {
    return 'traditional';
  }
}

export function setSpatialVoiceMode(mode: SpatialVoiceMode) {
  try {
    localStorage.setItem(key, mode);
    fallback = undefined;
  } catch {
    fallback = mode;
  }
  window.dispatchEvent(new Event(event));
}

function subscribe(listener: () => void) {
  window.addEventListener(event, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(event, listener);
    window.removeEventListener('storage', listener);
  };
}

export function useSpatialVoiceMode() {
  return useSyncExternalStore(
    subscribe,
    readSpatialVoiceMode,
    () => 'traditional',
  );
}
