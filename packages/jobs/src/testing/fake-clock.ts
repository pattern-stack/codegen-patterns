import type { Clock } from '../ports/clock.ts';

export interface FakeClock extends Clock {
  /** Moves time on. */
  advance(ms: number): void;
  set(date: Date): void;
}

/**
 * A clock tests move. `sleep` moves time on by its duration and resolves on the next turn of the event loop, so a
 * backoff waits no real time and a test never sleeps for real.
 */
export function fakeClock(start = new Date('2026-11-15T12:00:00Z')): FakeClock {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance(ms) {
      t += ms;
    },
    set(date) {
      t = date.getTime();
    },
    sleep(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        t += Math.max(0, ms);
        setTimeout(() => {
          if (signal?.aborted) reject(signal.reason);
          else resolve();
        }, 0);
      });
    },
  };
}
