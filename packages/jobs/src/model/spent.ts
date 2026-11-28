import type { Spend } from './run.ts';

/** Where a thrown error carries what its call spent. `Symbol.for`, so two copies of the package read the same mark. */
const SPENT = Symbol.for('@pattern-stack/jobs.spent');

/**
 * Marks an error a call threw after it paid: `throw withSpend(err, { calls: 1, inputTokens, costUsd })`. The engine
 * records that spend on the run (`JobStore.addSpend`) whatever the error does next (a retry, a split to the bad item,
 * a failure), so money a provider charged is never lost to an error. The error keeps its identity, its type and its
 * retry class; a thrown value that isn't an object is wrapped in an `Error` first.
 */
export function withSpend<E>(
  err: E,
  spend: Partial<Spend>,
): E extends object ? E : Error {
  const target: object =
    typeof err === 'object' && err !== null ? err : new Error(String(err));
  Object.defineProperty(target, SPENT, {
    value: spendOf(spend),
    enumerable: false,
    configurable: true,
  });
  return target as E extends object ? E : Error;
}

/** The spend a thrown error carries, or undefined when it carries none. */
export function spendOfError(err: unknown): Spend | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const spend: unknown = (err as Record<symbol, unknown>)[SPENT];
  return spend === undefined ? undefined : (spend as Spend);
}

/** A call's spend: one call unless it says otherwise, nothing else. */
export const spendOf = (s: Partial<Spend> | undefined): Spend => ({
  calls: s?.calls ?? 1,
  inputTokens: s?.inputTokens ?? 0,
  costUsd: s?.costUsd ?? 0,
});
