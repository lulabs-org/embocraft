import type { WorldEvent, ChatData } from '@voxel/shared';
export function visibleEvent(event: WorldEvent, playerId: string) {
  if (event.type !== 'chat') return true;
  const d = event.data as ChatData;
  return (
    (d.scope !== 'private' && d.scope !== 'nearby') ||
    event.actor === playerId ||
    d.recipients.includes(playerId)
  );
}
