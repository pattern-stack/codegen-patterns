import type { ItemRef } from '../model/item.ts';

/** One map-step result as its recorder keeps it. */
export interface RecordedResult<R> {
  key: string;
  ref: ItemRef;
  result: R;
}

/**
 * Where a map step's item results live: the job kind's own tables (a verdict per observation), never a JSON column.
 * One recorder per map step, so its scope is implicit. Results are shared across runs of the same meaning: the first
 * write of a key wins within a tenant, and a later run reads it instead of asking again.
 */
export interface ResultRecorder<R> {
  /** First write wins per tenant and key: a key already saved keeps its result. `runId` is the producer. */
  save(
    tenantId: string,
    runId: string,
    results: RecordedResult<R>[],
  ): Promise<void>;
  /** What exists for these keys; a missing key has no entry. */
  load(
    tenantId: string,
    keys: string[],
  ): Promise<Map<string, RecordedResult<R>>>;
}
