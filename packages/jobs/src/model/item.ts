/** An entity id (a document id, an account id), never content. */
export type ItemRef = string;

/** An item with its idempotency key and its reference. */
export interface Keyed<Item> {
  key: string;
  ref: ItemRef;
  item: Item;
}

/** skipped: past a map step's early stop, discarded from its result. */
export type ItemStatus = 'pending' | 'done' | 'cached' | 'failed' | 'skipped';

/** One planned item of a map step, in the order its step planned it. */
export interface Item {
  runId: string;
  step: string;
  ordinal: number;
  /** Its chunk; null for a children step's slot, which has none. */
  chunkIndex: number | null;
  key: string;
  ref: ItemRef;
  status: ItemStatus;
  attempts: number;
  errorType: string | null;
}

/**
 * A finished item as the engine writes it; the store adds the tenant, scope, run and time. `result` is there
 * only when the store keeps values and the step names no recorder; otherwise the value lives in its recorder.
 */
export interface Done<R> {
  key: string;
  ref: ItemRef;
  result?: R;
}

export interface Failed {
  key: string;
  errorType: string;
}

/**
 * A stored result, written once per key within a tenant and a scope (the job key and the step name): the
 * first write wins, so a retried or late write never changes it, and a later run of the same meaning reads it.
 */
export interface ItemResult<R> {
  tenantId: string;
  scope: string;
  key: string;
  ref: ItemRef;
  result: R;
  /** The producer. */
  runId: string;
  createdAt: Date;
}

/**
 * The result namespace of a map step that names no `cacheScope`: results are shared across runs of the same job and
 * step. A step's `cacheScope` replaces it.
 */
export const resultScope = (jobKey: string, step: string): string =>
  `${jobKey}/${step}`;
