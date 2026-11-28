import type { RunScope } from '../ports/run-scope.ts';
import type { Registry } from '../define/registry.ts';
import type { StopScans } from '../engine/stop-scan.ts';
import type { Run } from '../model/run.ts';
import type { Clock } from '../ports/clock.ts';
import type { EventSink } from '../ports/event-sink.ts';
import type { JobStore } from '../ports/job-store.ts';
import type { Limiters } from '../ports/limiter.ts';

/** What an advance or chunk job runs on: the executor's ports, and its dispatch and lifecycle. */
export interface JobEngineRuntime {
  readonly store: JobStore;
  readonly registry: Registry;
  readonly clock: Clock;
  readonly events: EventSink;
  /** Aborts an advance when the executor stops without drain. */
  readonly signal: AbortSignal;
  readonly owner: string;
  readonly claimTtlMs: number;
  readonly pageSize: number;
  readonly limiters: Limiters;
  /** This process's early-stop scans. */
  readonly stops: StopScans;
  /** The host's run scope, around every advance and chunk. */
  readonly around: RunScope | undefined;
  /** Whether a run of another version is past this process's drain window (`versionGraceMs`). */
  versionGone(run: Run): boolean;
  /** Enqueues the run's next advance, carrying the trace root. */
  enqueueAdvance(runId: string, carried: unknown): Promise<void>;
  /** Enqueues a job for each of the run's pending chunks, delayed to its `runAt`. */
  dispatch(runId: string, carried: unknown): Promise<void>;
  /** Registers an in-flight chunk's controller; the returned function unregisters it. */
  track(controller: AbortController): () => void;
  stoppingWithoutDrain(): boolean;
  /** An error off the job's own path (a heartbeat, a background dispatch): logged, never thrown. */
  report(err: unknown): void;
}
