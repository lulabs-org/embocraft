import { vi } from 'vitest';
import { navigationWorld } from '../../../tests/support/navigation-world';

export const signal = () => new AbortController().signal;

export async function physics<T>(
  w: ReturnType<typeof navigationWorld>,
  work: () => Promise<T>,
) {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });
  const timer = setInterval(w.tick, 50);
  let done = false;
  try {
    const pending = work();
    void pending.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    for (let i = 0; i < 600 && !done; i++) {
      await vi.advanceTimersByTimeAsync(100);
      await new Promise<void>((r) => setImmediate(r));
    }
    return await pending;
  } finally {
    clearInterval(timer);
    vi.useRealTimers();
  }
}

