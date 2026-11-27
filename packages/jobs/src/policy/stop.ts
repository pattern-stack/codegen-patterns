import type { ItemRef } from '../model/item.ts';

/** One item of a map step as its early stop reads it, in planned order. */
export type ItemOutcome<R> =
  | { key: string; ref: ItemRef; ok: true; result: R }
  | { key: string; ref: ItemRef; ok: false; errorType: string };

/**
 * An ordered early stop: true means "stop after this item". Read over the items in their order, never past an item
 * that is not yet settled, so the stop found never depends on how far ahead the engine worked.
 */
export type StopPredicate<R> = (
  outcome: ItemOutcome<R>,
  index: number,
  before: readonly ItemOutcome<R>[],
) => boolean;

/**
 * The first stop in a settled prefix: the number of items the result keeps (the stopping item included), or null
 * when the prefix holds no stop yet. `settled` must be the contiguous settled prefix, in planned order.
 */
export function firstStop<R>(
  settled: readonly ItemOutcome<R>[],
  stopWhen: StopPredicate<R>,
): number | null {
  // One growing array, so a predicate sees exactly the items before it and never one the engine worked ahead to.
  const before: ItemOutcome<R>[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i] as ItemOutcome<R>;
    if (stopWhen(outcome, i, before)) return i + 1;
    before.push(outcome);
  }
  return null;
}

/** How far a step worked against how far its stop used. */
export const speculationOf = (settled: number, used: number) => ({
  speculated: settled,
  used,
  overshoot: Math.max(0, settled - used),
});
