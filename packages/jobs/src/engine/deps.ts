import type { Registry } from '../define/registry.ts';
import type { Run } from '../model/run.ts';
import type { Clock } from '../ports/clock.ts';
import type { EventSink } from '../ports/event-sink.ts';
import type { JobStore } from '../ports/job-store.ts';
import type { Limiters } from '../ports/limiter.ts';
import type { StopScans } from './stop-scan.ts';

/** What the engine runs on: every clock read, id, write and event goes through these ports. */
export interface EngineDeps {
  store: JobStore;
  registry: Registry;
  clock: Clock;
  events: EventSink;
  /** Aborts on a stop or a crash. */
  signal: AbortSignal;
  /** The quotas steps name: a map step's calls draw on them, a plain step holds a slot for its run. */
  limiters: Limiters;
  /** The executor's early-stop scans, so reading a step's stop never re-reads its whole prefix. Default: none kept. */
  stops?: StopScans;
}

export interface AdvanceDeps extends EngineDeps {
  /** Source page size while planning a map step. Default 1000. */
  pageSize?: number;
  /** Called when planning makes new chunks claimable. */
  onChange?: () => void;
  /**
   * Makes another run's work eligible: a children step's new children, and a child's parent once it ended. Only the
   * fast path: a pending child and a poked parent are found by the sweep.
   */
  submit?: (runId: string) => Promise<void>;
  /**
   * Whether a run of a version this process doesn't have is past its drain window: then its advance fails it
   * (`JobVersionGoneError`). Default: never, so the advance throws and leaves it to a process that has its version.
   */
  versionGone?: (run: Run) => boolean;
}

export type ChunkDeps = EngineDeps;
