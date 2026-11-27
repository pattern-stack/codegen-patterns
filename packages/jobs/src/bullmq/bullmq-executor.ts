import type { RunScope } from '../ports/run-scope.ts';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { localLimiters } from '../adapters/local-limiter.ts';
import { memorySweepCursors } from '../adapters/memory-sweep-cursors.ts';
import { systemClock } from '../adapters/system-clock.ts';
import type { Registry } from '../define/registry.ts';
import { createEmitter, type EmitterOptions } from '../engine/emitter.ts';
import type { ChunkOutcome } from '../engine/process-chunk.ts';
import { StopScans } from '../engine/stop-scan.ts';
import {
  assertStoreHoldsValues,
  assertStoreSafeFor,
} from '../engine/values.ts';
import { errorTypeOf, JobDefinitionError } from '../model/errors.ts';
import type { Clock } from '../ports/clock.ts';
import type { EventSink } from '../ports/event-sink.ts';
import type { Executor } from '../ports/executor.ts';
import type { JobStore } from '../ports/job-store.ts';
import type { Limiters } from '../ports/limiter.ts';
import type { SweepCursors } from '../ports/sweep-cursors.ts';
import {
  advanceOptions,
  chunkJobId,
  isChunkJob,
  JOB_ENGINE_JOBS,
  type JobEngineJob,
  type JobEngineQueue,
  ONCE,
} from './job-data.ts';
import { runAdvanceJob } from './run-advance-job.ts';
import { runChunkJob } from './run-chunk-job.ts';
import type { JobEngineRuntime } from './runtime.ts';

export interface BullmqExecutorOptions {
  /** The host's run scope: every advance and chunk runs inside it, as the in-process executor's do (`RunScope`). */
  around?: RunScope;
  /**
   * The quotas steps name, by name and bucket. Default `localLimiters()`: in memory, per process, so N workers get N
   * times each quota; `redisLimiters` (`@pattern-stack/jobs/redis`) holds one quota across processes.
   */
  limiters?: Limiters;
  sinks?: readonly EventSink[];
  emitter?: EmitterOptions;
  clock?: Clock;
  /** Default `bullmq:<host>:<pid>:<8 hex>`. */
  owner?: string;
  /** Default 60 s; the heartbeat renews every third of it. */
  claimTtlMs?: number;
  /** Source page size while planning. Default 1000. */
  pageSize?: number;
  /**
   * Where each sweep's pages left off. Default `memorySweepCursors()`: this process's own, so with several workers
   * each continues only from its own last sweep; `redisSweepCursors` (`@pattern-stack/jobs/redis`) shares one across them.
   */
  sweepCursors?: SweepCursors;
  /** Runs one sweep resubmits, and due runs it wakes. Default `SWEEP_RUNS`. */
  sweepRuns?: number;
  /** Pending chunks one advance reads and enqueues, due first; past the workers' concurrency. Default `DISPATCH_WINDOW`. */
  dispatchWindow?: number;
  /**
   * The drain window a version bump gives open runs of the old version: until this process has been up this long, it
   * leaves them to processes still on that version; after, an advance fails them (`JobVersionGoneError`). Default
   * `VERSION_GRACE_MS`, past a rolling deploy.
   */
  versionGraceMs?: number;
  /**
   * Where a warning goes: a run skipped for another version or for a job this process doesn't know, a failed
   * heartbeat. Default `console.warn`.
   */
  warn?: (message: string) => void;
}

/** What the worker passes with a job it hands to `handle`. */
export interface HandleOptions {
  /** The trace root opened for this job, carried only when the job arrived with none. Opaque to the package. */
  trace?: unknown;
}

/** How a handled job went. */
export type HandleOutcome = 'advanced' | ChunkOutcome | 'skipped';

/** How many open runs one sweep resubmits; successive sweeps rotate through the rest. */
export const SWEEP_RUNS = 500;

/** A version bump's drain window on BullMQ: 15 minutes, past a rolling deploy. */
export const VERSION_GRACE_MS = 15 * 60_000;

/** How many pending chunks one advance enqueues, due first: more than the workers run at once. */
export const DISPATCH_WINDOW = 64;

/** Runs whose enqueued chunks one process remembers. */
const DISPATCHED_RUNS = 1_000;

interface SentChunk {
  mark: string;
  sentAt: number;
}

/**
 * Runs jobs on BullMQ. Postgres (the store) is the truth; BullMQ only dispatches: one queue, two job names, `advance`
 * (a run's step loop, deduplicated per run so advances never overlap and a wake-up is never lost) and `chunk` (one
 * chunk, its job id the chunk and its attempt). Every job runs once (`attempts: 1`): retries and backoff are the
 * engine's, attempts the store's. The app's worker owns the BullMQ `Worker` and calls `handle` with each job; a
 * scheduled `sweep` returns expired claims, resubmits open runs and wakes due waits.
 */
export class BullmqExecutor implements Executor {
  readonly owner: string;
  private readonly events: EventSink;
  private readonly clock: Clock;
  private readonly limiters: Limiters;
  private readonly around: RunScope | undefined;
  private readonly stops = new StopScans();
  private readonly claimTtlMs: number;
  private readonly pageSize: number;
  private readonly warn: (message: string) => void;
  private readonly inFlight = new Set<AbortController>();
  private readonly killer = new AbortController();
  /** Where the last sweep, on any process sharing them, left off. */
  private readonly sweepCursors: SweepCursors;
  private readonly sweepRuns: number;
  private readonly dispatchWindow: number;
  private readonly versionGraceMs: number;
  /** When this process's executor was made: the drain window runs from here. */
  private readonly bootAt: number;
  /**
   * Per run, by chunk, the job (id and `runAt`) this process last enqueued and when: enqueued once, not once per
   * advance. Forgotten when this process handles the chunk's job, and stale after `claimTtlMs`, so a job consumed
   * without settling its chunk (handled early, skipped while stopping, on another process) is enqueued again.
   */
  private readonly dispatched = new Map<string, Map<string, SentChunk>>();
  private accepting = true;
  private stopping = false;

  constructor(
    private readonly queue: JobEngineQueue,
    private readonly store: JobStore,
    private readonly registry: Registry,
    options: BullmqExecutorOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.events = createEmitter(
      options.sinks ?? [],
      this.clock,
      options.emitter,
    );
    this.limiters = options.limiters ?? localLimiters();
    this.around = options.around;
    this.owner =
      options.owner ??
      `bullmq:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.claimTtlMs = options.claimTtlMs ?? 60_000;
    this.pageSize = options.pageSize ?? 1_000;
    this.warn =
      options.warn ??
      ((m) => {
        process.stderr.write(`${m}\n`);
      });
    this.sweepCursors = options.sweepCursors ?? memorySweepCursors();
    this.sweepRuns = options.sweepRuns ?? SWEEP_RUNS;
    this.dispatchWindow = options.dispatchWindow ?? DISPATCH_WINDOW;
    this.versionGraceMs = options.versionGraceMs ?? VERSION_GRACE_MS;
    this.bootAt = this.clock.now().getTime();
  }

  /** Makes a run's work eligible: queues its next advance. Refuses a job its store cannot run. */
  async submit(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    const job = this.registry.get(run.jobKey);
    assertStoreHoldsValues(job, this.store);
    assertStoreSafeFor(job, this.store);
    // No trace context: the worker opens the run's own root, so no caller's root ever rides a deduplicated advance.
    await this.enqueueAdvance(runId, undefined);
  }

  private enqueueAdvance = async (
    runId: string,
    carried: unknown,
  ): Promise<void> => {
    await this.queue.add(
      JOB_ENGINE_JOBS.advance,
      { runId, workflowContext: carried },
      advanceOptions(runId),
    );
  };

  /**
   * Enqueues a window of the run's pending chunks, due first, skipping each this process already enqueued at the same
   * attempt and `runAt`: an advance follows every settle, so reading and re-enqueueing every pending chunk each time
   * was quadratic in the run's chunks. A chunk past the window is enqueued by a later advance, once those ahead of it
   * left pending; one enqueued by another process is enqueued here once more, deduplicated by its job id.
   */
  private dispatch = async (runId: string, carried: unknown): Promise<void> => {
    const run = await this.store.getRun(runId);
    if (run.status !== 'running') {
      this.dispatched.delete(runId);
      return;
    }
    const now = this.clock.now().getTime();
    const sent = this.sentFor(runId);
    for (const c of await this.store.pendingChunks(
      runId,
      this.dispatchWindow,
    )) {
      const jobId = chunkJobId(c);
      const mark = `${jobId}@${c.runAt.getTime()}`;
      const at = `${c.step}#${c.index}`;
      const prior = sent.get(at);
      if (prior?.mark === mark && now - prior.sentAt < this.claimTtlMs)
        continue;
      await this.queue.add(
        JOB_ENGINE_JOBS.chunk,
        { runId, step: c.step, index: c.index, workflowContext: carried },
        {
          ...ONCE,
          jobId,
          delay: Math.max(0, c.runAt.getTime() - now),
        },
      );
      sent.set(at, { mark, sentAt: now });
    }
  };

  /** Whether this process has been up past the drain window a version bump gives. */
  private versionGone(): boolean {
    return this.clock.now().getTime() - this.bootAt >= this.versionGraceMs;
  }

  /** The chunk jobs this process enqueued for a run, the oldest runs dropped first past `DISPATCHED_RUNS`. */
  private sentFor(runId: string): Map<string, SentChunk> {
    let sent = this.dispatched.get(runId);
    if (sent) this.dispatched.delete(runId);
    else {
      sent = new Map();
      if (this.dispatched.size >= DISPATCHED_RUNS) {
        const oldest = this.dispatched.keys().next().value;
        if (oldest !== undefined) this.dispatched.delete(oldest);
      }
    }
    this.dispatched.set(runId, sent);
    return sent;
  }

  private runtime(): JobEngineRuntime {
    return {
      store: this.store,
      registry: this.registry,
      clock: this.clock,
      events: this.events,
      signal: this.killer.signal,
      owner: this.owner,
      claimTtlMs: this.claimTtlMs,
      pageSize: this.pageSize,
      limiters: this.limiters,
      stops: this.stops,
      around: this.around,
      versionGone: () => this.versionGone(),
      enqueueAdvance: this.enqueueAdvance,
      dispatch: this.dispatch,
      track: (controller) => {
        this.inFlight.add(controller);
        if (this.stopping)
          controller.abort(new Error('the executor is stopping'));
        return () => this.inFlight.delete(controller);
      },
      stoppingWithoutDrain: () => this.stopping,
      report: (err) =>
        this.warn(`@pattern-stack/jobs bullmq: ${errorTypeOf(err)} off a job's path`),
    };
  }

  /**
   * Accepts jobs again after a `stop()`. A new executor already accepts: the app's worker may fetch jobs before the
   * app calls this, and a job skipped then would lose its run's wake-up until the next sweep.
   */
  async start(): Promise<void> {
    this.accepting = true;
  }

  /**
   * Stops accepting: a job handled from now on is skipped (its chunk stays pending for the next dispatch). Without
   * drain, in-flight chunks are aborted and each gives back only its own claim. The app's worker close waits for
   * in-flight jobs, which is the drain.
   */
  async stop(options: { drain?: boolean } = {}): Promise<void> {
    this.accepting = false;
    if (options.drain === false) {
      this.stopping = true;
      this.killer.abort(new Error('the executor is stopping'));
      for (const c of this.inFlight)
        c.abort(new Error('the executor is stopping'));
    }
  }

  /**
   * The worker side: what the app's processor calls with each job of the queue. A run of a job this process doesn't
   * know, or made by another definition version, is skipped with a warning (a rolling deploy: a process that has it
   * takes it); any other error is thrown, so BullMQ fails the job and the app reports it.
   *
   * `trace` is the run's trace root the caller opened for this job (the app's worker opens one per job): every job
   * this handling enqueues carries it, unless the job arrived with a root of its own, which always wins, so a stage is
   * never carried. A submit never carries one (a caller's context on a deduplicated advance would decide which caller
   * the whole run nests under), and neither does the sweep.
   */
  async handle(
    job: JobEngineJob,
    options: HandleOptions = {},
  ): Promise<HandleOutcome> {
    const { data } = job;
    // A chunk's job is out of the queue now, skipped or not: a dispatch may enqueue the chunk again.
    if (isChunkJob(data))
      this.dispatched.get(data.runId)?.delete(`${data.step}#${data.index}`);
    if (!this.accepting) return 'skipped';
    const run = await this.store.getRun(data.runId);
    if (!this.registry.has(run.jobKey)) {
      this.warn(
        `@pattern-stack/jobs bullmq: run ${run.id} is of ${run.jobKey}, a job this process doesn't have, so it is left for a process that has it`,
      );
      return 'skipped';
    }
    const definition = this.registry.get(run.jobKey);
    // Within the drain window a run of another version is left for a process still on it; past it, its advance fails
    // the run (`JobVersionGoneError`).
    if (
      definition.version !== run.jobVersion &&
      !(job.name === JOB_ENGINE_JOBS.advance && this.versionGone())
    ) {
      this.warn(
        `@pattern-stack/jobs bullmq: run ${run.id} of ${run.jobKey} was made by version ${run.jobVersion}; this process has ${definition.version}, so it is left for a process that has it`,
      );
      return 'skipped';
    }
    // The run's own root: the one this job arrived with, else the one opened for it. Never a caller's.
    const carried = data.workflowContext ?? options.trace;
    if (job.name === JOB_ENGINE_JOBS.chunk && isChunkJob(data))
      return runChunkJob(this.runtime(), data, carried);
    if (job.name === JOB_ENGINE_JOBS.advance)
      return runAdvanceJob(this.runtime(), data, carried);
    throw new JobDefinitionError(
      `the job engine runs no job named ${job.name}`,
    );
  }

  /**
   * The backstop: expired claims back to pending, then a page of open runs resubmitted (deduplicated, so cheap).
   * Each sweep continues past the last run the previous one resubmitted (on whichever process, through the shared
   * `sweepCursors`) and starts over after a short page, so every open run is resubmitted within ⌈open / SWEEP_RUNS⌉
   * sweeps however many old ones are left open (a run of another
   * version is skipped by the worker, not closed).
   */
  async sweep(): Promise<{
    swept: number;
    resubmitted: number;
    woken: number;
  }> {
    const swept = await this.store.sweepExpired();
    const page = this.sweepRuns;
    const cursors = this.sweepCursors;
    const open = await this.store.openRunIds(page, await cursors.get('open'));
    await cursors.set('open', open.length < page ? undefined : open.at(-1));
    // A sweep carries no trace root: each resubmit opens a fresh one, correlated by the run id.
    for (const runId of open) await this.enqueueAdvance(runId, undefined);
    // Waiting runs are not open work: only those whose wait is due are woken, and their advance decides.
    const due = await this.store.dueRunIds(
      this.clock.now(),
      page,
      await cursors.get('due'),
    );
    await cursors.set('due', due.length < page ? undefined : due.at(-1));
    for (const runId of due) await this.enqueueAdvance(runId, undefined);
    return { swept, resubmitted: open.length, woken: due.length };
  }
}
