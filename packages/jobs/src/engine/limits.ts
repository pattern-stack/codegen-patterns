import { limiterKey, type StepLimiter } from '../define/limits.ts';
import type { Limiters, Permit } from '../ports/limiter.ts';

/**
 * One slot on each of a step's limiters, taken in their (sorted) order, as one permit. A wait that fails partway
 * releases what it took. The release reaches every limiter: a 429 throttles each bucket the call drew on.
 */
export async function acquireAll(
  limiters: Limiters,
  steps: readonly StepLimiter[],
  tenantId: string,
  cost: { tokens: number },
  signal?: AbortSignal,
): Promise<Permit> {
  const held: Permit[] = [];
  try {
    for (const l of steps)
      held.push(
        await limiters
          .get(l.name, limiterKey(l, tenantId))
          .acquire(cost, signal),
      );
  } catch (err) {
    for (const p of held.reverse()) p.release();
    throw err;
  }
  let released = false;
  return {
    async release(outcome) {
      if (released) return;
      released = true;
      for (let i = held.length - 1; i >= 0; i--)
        await (held[i] as Permit).release(outcome);
    },
  };
}
