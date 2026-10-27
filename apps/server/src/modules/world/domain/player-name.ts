export function normalizePlayerName(value: unknown): string {
  const name = typeof value === 'string' ? value.normalize('NFC').trim() : '';
  return name.slice(0, 24).trim() || 'Explorer';
}

export function playerNameKey(value: unknown): string {
  return normalizePlayerName(value).toLowerCase();
}

export const PLAYER_NAME_TAKEN = 4409;
