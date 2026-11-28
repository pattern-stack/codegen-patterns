import type { Budget } from './run.ts';

/** A children step's slot status: its child running, done, failed (failed or canceled), or skipped by an operator. */
export type SlotStatus = 'pending' | 'done' | 'failed' | 'skipped';

/**
 * One slot of a children step: one key, one child run at a time (a retry moves the ref to a new run). Stored as an
 * item of the step (`item_key` the key, `item_ref` the child run id, no chunk), so a key has one slot for good.
 */
export interface Slot {
  key: string;
  childRunId: string;
  ordinal: number;
  status: SlotStatus;
  /** Child runs the slot has had: 1, and one more per retry. */
  attempts: number;
  /** Its child's error type when it failed (`Canceled` for a canceled child); null otherwise. */
  errorType: string | null;
}

/** A child to start in a slot: its key, job, input and budget. */
export interface NewChild {
  key: string;
  jobKey: string;
  jobVersion: string;
  /** Kept by the store as the child run's input. */
  input: unknown;
  budget: Budget;
}

/** At most this many children in one step: more belongs in a map step. */
export const MAX_CHILDREN = 100;
