/**
 * A lease on advancing a run: an optional store capability the in-process executor uses so that, of several
 * processes driving one store, only one advances a run at a time. The engine leaves "one advancer per run" to the
 * executor (`executor.ts`); within one process the executor's own map holds it, BullMQ holds it with deduplicated
 * advance jobs, and across in-process executors this lease holds it. Without it, a second process that reads a plain
 * step still running elsewhere restarts it (a crash mid-step spends its attempt), and the step's code runs twice at
 * once.
 *
 * A lease is the run's, by owner and token, until it expires by the store's clock; the holder renews it while its
 * advance runs and releases it after. An expired lease is anyone's, so a process that dies holding one stops
 * blocking the run after `ttlMs`.
 */
export interface RunLease {
  runId: string;
  owner: string;
  token: string;
  expiresAt: Date;
}

export interface RunLeases {
  /**
   * Takes the run's lease for `owner` until `ttlMs` from the store's now: when no one holds it, it expired, or `owner`
   * already holds it (a fresh token). Null when another owner holds an unexpired lease, or the run is unknown.
   */
  leaseRun(runId: string, owner: string, ttlMs: number): Promise<RunLease | null>;
  /** Extends each lease still held by its owner and token; the rest are lost (expired and taken, or released). */
  renewRunLeases(
    leases: readonly RunLease[],
    ttlMs: number,
  ): Promise<{ lost: RunLease[] }>;
  /** Releases a lease still held by its owner and token; a lost one is left as it is. */
  releaseRunLease(lease: RunLease): Promise<void>;
}
