/**
 * Where job code runs: an executor (and `startRun`, `signalRun`) wraps every call into a job's own code in this, so
 * the host can enter the run's scope around it, codegen's generated repositories reading the tenant from
 * `AsyncLocalStorage` (its ADR-042). It wraps a run's whole advance (a plain step, a gate check, a map step's source,
 * a children step's `each` and its children's `admit`), each chunk's processing (`hydrate` and the batches), a start's
 * `admit` (no run yet: `runId` null) and a signal's `accept`. These are effects inside steps, so the engine's
 * determinism is untouched.
 */
export interface RunScopeTarget {
  /** Null for a start's `admit`: the run doesn't exist yet. */
  runId: string | null;
  tenantId: string;
  jobKey: string;
}

export type RunScope = <T>(target: RunScopeTarget, fn: () => Promise<T>) => Promise<T>;

/** Runs `fn` in `scope`, or as it is with none. */
export const inScope = <T>(
  scope: RunScope | undefined,
  target: RunScopeTarget,
  fn: () => Promise<T>,
): Promise<T> => (scope ? scope(target, fn) : fn());
