/**
 * `@pattern-stack/jobs/ports`: for adapter authors (a store, an executor, a sink). The port interfaces, the types they speak,
 * and `processChunk`, the one function every executor calls per chunk. An adapter never sees how steps advance.
 */

export type { ChunkDeps, EngineDeps } from './engine/deps.ts';
export { type ChunkOutcome, processChunk } from './engine/process-chunk.ts';
export type { NewChild, Slot, SlotStatus } from './model/children.ts';
export type {
  Chunk,
  ChunkClaim,
  ChunkStatus,
  RenewReport,
  SettleOutcome,
} from './model/chunk.ts';
export { ClaimLostError, RunNotFoundError } from './model/errors.ts';
export {
  type Done,
  type Failed,
  type Item,
  type ItemResult,
  resultScope,
} from './model/item.ts';
export {
  budgetStop,
  canTransition,
  type NewRun,
  type RunTransition,
} from './model/run.ts';
export { classifyError, computeBackoff } from './policy/retry.ts';
export type { Clock } from './ports/clock.ts';
export type { EventSink } from './ports/event-sink.ts';
export type { Executor } from './ports/executor.ts';
export type {
  ItemRange,
  JobStore,
  Reservation,
} from './ports/job-store.ts';
export {
  DEFAULT_LEASE_MS,
  type Limiter,
  type LimiterConfig,
  type Limiters,
  type Permit,
} from './ports/limiter.ts';
export type {
  RecordedResult,
  ResultRecorder,
} from './ports/result-recorder.ts';
export type { StepRecorder } from './ports/step-recorder.ts';
export type {
  SweepCursorName,
  SweepCursors,
} from './ports/sweep-cursors.ts';
export type { RunLease, RunLeases } from './ports/run-lease.ts';
export { inScope, type RunScope, type RunScopeTarget } from './ports/run-scope.ts';
