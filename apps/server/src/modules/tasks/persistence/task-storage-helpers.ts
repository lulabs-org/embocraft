import type { Prisma } from '@prisma/client';

/** Domain/API timestamps stay epoch milliseconds; database timestamps are UTC. */
export function timestamp(value: number): Date {
  if (!Number.isSafeInteger(value)) throw new Error('Invalid task timestamp.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error('Invalid task timestamp.');
  return date;
}

/** Preserve large cumulative counters without silently rounding on either boundary. */
export function counter(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid task counter.');
  return BigInt(value);
}

export function counterNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error('Task counter exceeds the supported range.');
  return number;
}

export function taskJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** SQL NULL represents an absent optional domain field, including legacy overrides. */
export function withoutNullFields<T extends object>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null),
  );
}
