import type { RunError, RunStatus, Spend } from './run.ts';
import type { Counts } from './step-state.ts';

export type ChunkStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled';

/**
 * A block of a map step's items: the unit the engine claims, tracks and retries. Adapter-facing; a job author never
 * sets or sees one.
 */
export interface Chunk {
  runId: string;
  step: string;
  index: number;
  status: ChunkStatus;
  /** Claims so far. A crash spends one too, so a chunk that keeps killing its worker still ends. */
  attempts: number;
  /** Next eligible, after backoff. */
  runAt: Date;
  /** Who holds it, by which claim, and until when; how a store holds a claim (a lease in Postgres) is its business. */
  claim: { owner: string; token: string; expiresAt: Date } | null;
  counts: Counts;
  spend: Spend;
  lastError: RunError | null;
}

/** A worker's hold on one chunk. Every write it makes for the chunk is fenced by it (`ClaimLostError`). */
export interface ChunkClaim {
  runId: string;
  step: string;
  index: number;
  owner: string;
  /**
   * This claim's own id, made by the store. The fence compares it, never only the owner: one worker re-claiming a
   * chunk it was swept from holds a new claim, and the stale one is fenced out.
   */
  token: string;
  expiresAt: Date;
  /** Claims so far, this one included. */
  attempts: number;
}

export interface RenewReport {
  /** Claims this owner no longer holds: swept, or its run or step stopped. */
  lost: ChunkClaim[];
  /** Each claimed run's status, so a worker sees a cancel or a pause. */
  runs: Record<string, RunStatus>;
}

export type SettleOutcome =
  | { kind: 'completed' }
  | { kind: 'retry'; at: Date; error: RunError }
  | { kind: 'failed'; error: RunError }
  /** Back to pending without spending an attempt: the run paused under the chunk, or its worker is shutting down. */
  | { kind: 'yield' };
