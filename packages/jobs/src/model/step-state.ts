import type { ChunkStatus } from './chunk.ts';
import type { RunError } from './run.ts';

export type StepStatus =
  | 'pending'
  | 'running'
  /** Parked on its wait (`StepState.wait`): nothing of it is in flight. */
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'skipped';

/** What a waiting step waits on. */
export type WaitKind = 'children' | 'signal' | 'gate';
export const WAIT_KINDS: readonly WaitKind[] = ['children', 'signal', 'gate'];

/**
 * A step's wait, held on its row. `kind` and `name` stay after the wait settles (what it waited for); `wakeAt` is when
 * the advance looks again (a gate's next poll), null once it settled or when only an event wakes it.
 */
export interface StepWait {
  kind: WaitKind;
  /** The gate's or signal's name: a code constant, never content. */
  name: string;
  since: Date;
  wakeAt: Date | null;
}

/** A map step's items. pending = total − the rest. */
export interface Counts {
  total: number;
  done: number;
  cached: number;
  failed: number;
  skipped: number;
}

export const zeroCounts = (): Counts => ({
  total: 0,
  done: 0,
  cached: 0,
  failed: 0,
  skipped: 0,
});

/**
 * How far a map step worked against how far its early stop used. The result never depends on these: items past the
 * stop are discarded. They are recorded so the speculation width can be set from numbers, not guessed.
 */
export interface Speculation {
  /** Items settled when the step completed: how far ahead it worked. */
  speculated: number;
  /** Items in the result: up to and including the stop, or all of them. */
  used: number;
  /** Settled items past the stop. */
  overshoot: number;
}

export interface StepState {
  runId: string;
  name: string;
  index: number;
  /** A plain step, a map step, a step that waits for a signal, or one that starts child runs and waits for them. */
  kind: 'step' | 'map' | 'wait' | 'children';
  status: StepStatus;
  /** Starts so far (a plain step) or 1 once a map step started; a crash mid-step spends one too. */
  attempts: number;
  /** A map step's items; a plain step's stay zero. */
  counts: Counts;
  /** A map step's chunks by status. */
  chunks: Record<ChunkStatus, number>;
  /** A map step's source is exhausted, or `budget.maxItems` was reached. */
  planned: boolean;
  /** Where a map step's planning resumes. */
  sourceCursor: string | null;
  speculation: Speculation | null;
  /** Its wait while it waits, and what it waited for after; null for a step that never waited. */
  wait: StepWait | null;
  /** Who sent the signal that settled its wait; null for a timeout's value, or a step no signal settled. */
  settledBy: string | null;
  error: RunError | null;
  startedAt: Date | null;
  completedAt: Date | null;
}
