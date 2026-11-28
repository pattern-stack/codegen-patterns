import { randomUUID } from 'node:crypto';
import type { AnyJob, JobDefinition } from '../define/define-job.ts';
import { createRegistry, type Registry } from '../define/registry.ts';
import { advanceRun } from '../engine/advance-run.ts';
import { runOutputOf } from '../engine/context.ts';
import type { AdvanceDeps, ChunkDeps } from '../engine/deps.ts';
import { createEmitter, type EmitterOptions } from '../engine/emitter.ts';
import { abortsInFlight } from '../engine/heartbeat.ts';
import { processChunk } from '../engine/process-chunk.ts';
import { signalRun } from '../engine/signals.ts';
import { resumeRun, startRun } from '../engine/start-run.ts';
import { StopScans } from '../engine/stop-scan.ts';
import {
  assertStoreHoldsValues,
  assertStoreSafeFor,
} from '../engine/values.ts';
import type { ChunkClaim } from '../model/chunk.ts';
import { ClaimLostError } from '../model/errors.ts';
import {
  type Run,
  type RunProgress,
  type RunRequest,
  TERMINAL_RUN,
} from '../model/run.ts';
import type { StepState } from '../model/step-state.ts';
import type { Clock } from '../ports/clock.ts';
import type { EventSink } from '../ports/event-sink.ts';
import type { Executor } from '../ports/executor.ts';
import type { JobStore } from '../ports/job-store.ts';
import type { Limiters } from '../ports/limiter.ts';
import type { RunLease } from '../ports/run-lease.ts';
import {
  inScope,
  type RunScope,
  type RunScopeTarget,
} from '../ports/run-scope.ts';
import { localLimiters } from './local-limiter.ts';
import { systemClock } from './system-clock.ts';
import { memorySweepCursors } from './memory-sweep-cursors.ts';
import type { SweepCursors } from '../ports/sweep-cursors.ts';
import { type DrainWindow, drainWindow } from '../engine/drain-window.ts';

export interface InProcessOptions {
  store: JobStore;
  registry: Registry;
  /** The quotas steps name, by name and bucket; default `localLimiters()` (in memory, this executor's own). */
  limiters?: Limiters;
  sinks?: readonly EventSink[];
  emitter?: EmitterOptions;
  clock?: Clock;
  owner?: string;
  claimTtlMs?: number;
  /** Chunks in flight; default ceil(inFlight × callSize ÷ chunkSize) + 1, at least 1. */
  chunkConcurrency?: number;
  /** Source page size while planning. */
  pageSize?: number;
  pollMs?: number;
  /**
   * The drain window a version bump gives open runs of another version before an advance fails them
   * (`JobVersionGoneError`): until this process and the run are both older than it (`drainWindow`). Default 0: one
   * process has no other to leave them to. With replicas, set it longer than a deploy takes, so each side leaves the
   * other's runs meanwhile.
   */
  versionGraceMs?: number;
  /**
   * How often the drive loop sweeps the store's open runs (`openRunIds`, paged), in polls: every pending or running
   * run of a job this executor registers is advanced, whether or not anything submitted it. So a restarted process
   * resumes a run it was never handed, and a run another process created (a start inside the caller's transaction)
   * is found if its submit is lost. Default 20 (5 s at the default poll); the first sweep runs when the loop starts.
   */
  openSweepEvery?: number;
  /**
   * The advance lease's time to live, when the store has `runLeases`: renewed by the heartbeat while an advance runs,
   * so it only lapses when this process stops. Default `claimTtlMs`.
   */
  leaseTtlMs?: number;
  /** Wraps every call into a job's code with its run's scope (`RunScope`): the host enters its tenant scope here. */
  around?: RunScope;
  /**
   * Where a poll that failed is reported (a store call that threw: a dropped connection). The loop carries on at the
   * next poll; it never stops on one. Default stderr.
   */
  warn?: (message: string) => void;
  /** Where the open sweep's and the due wake's pages left off. Default `memorySweepCursors()`, this process's own. */
  sweepCursors?: SweepCursors;
}

/** Runs one open sweep, or one due wake, reads. */
export const IN_PROCESS_SWEEP_PAGE = 100;

interface Active {
  claim: ChunkClaim;
  controller: AbortController;
  done: Promise<void>;
}

/** A claim by value: its chunk and its token. */
const claimId = (c: ChunkClaim) =>
  `${c.runId}\u0000${c.step}\u0000${c.index}\u0000${c.token}`;

/** Calls of 200 at 6 in flight over chunks of 1,000: 3 chunks keep the limiter busy. */
const chunkConcurrencyFor = (chunkSize: number, inFlight = 6, callSize = 200) =>
  Math.max(1, Math.ceil((inFlight * callSize) / chunkSize) + 1);

/** The least of some times, or null for none. */
const earliestOf = (times: readonly number[]): number | null =>
  times.reduce<number | null>(
    (min, t) => (min === null || t < min ? t : min),
    null,
  );

/**
 * Runs jobs in this process: advances each submitted run's steps, and a claim loop processes map steps' chunks with
 * a heartbeat that renews claims (a lost claim, a cancel or a failure aborts its chunk; a pause lets its calls finish) and a sweeper that returns
 * expired claims to pending. `kill` acts out a crash: nothing is released, and the next process's sweep picks the
 * chunks up.
 */
export class InProcessExecutor implements Executor {
  readonly owner: string;
  private readonly store: JobStore;
  private readonly registry: Registry;
  /** The jobs its registry holds: the only ones whose chunks it claims. */
  private readonly jobKeys: readonly string[];
  private readonly limiters: Limiters;
  private readonly stops = new StopScans();
  private readonly events: EventSink;
  private readonly clock: Clock;
  private readonly claimTtlMs: number;
  private readonly pageSize: number;
  private readonly pollMs: number;
  private readonly fixedConcurrency: number | undefined;
  private concurrency = 1;
  private readonly active = new Map<string, Active>();
  private readonly advancing = new Map<
    string,
    { again: boolean; done: Promise<void> }
  >();
  private running = false;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private wakeUp: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  /** Runs this executor drives, for the idle wait's next retry. */
  private readonly submitted = new Set<string>();
  private readonly killer = new AbortController();
  private failure: unknown = null;
  private readonly drain: DrainWindow;
  private readonly sweepCursors: SweepCursors;
  private readonly warn: (message: string) => void;
  private readonly openSweepEvery: number;
  private polls = 0;
  private readonly leaseTtlMs: number;
  /** The advance leases this executor holds, by run: renewed by the heartbeat, released when the advance ends. */
  private readonly leases = new Map<string, RunLease>();
  private readonly around: RunScope | undefined;
  /** Each driven run's scope target: a run's tenant and job never change, so it is read once. */
  private readonly targets = new Map<string, RunScopeTarget>();

  constructor(options: InProcessOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.jobKeys = options.registry.list().map((job) => job.key);
    this.limiters = options.limiters ?? localLimiters();
    this.clock = options.clock ?? systemClock;
    this.events = createEmitter(
      options.sinks ?? [],
      this.clock,
      options.emitter,
    );
    this.owner = options.owner ?? `in-process:${process.pid}:${randomUUID()}`;
    this.claimTtlMs = options.claimTtlMs ?? 60_000;
    this.pageSize = options.pageSize ?? 1_000;
    this.pollMs = options.pollMs ?? 250;
    this.openSweepEvery = Math.max(1, options.openSweepEvery ?? 20);
    this.leaseTtlMs = options.leaseTtlMs ?? this.claimTtlMs;
    this.around = options.around;
    this.sweepCursors = options.sweepCursors ?? memorySweepCursors();
    this.warn =
      options.warn ??
      ((m) => {
        process.stderr.write(`${m}\n`);
      });
    this.drain = drainWindow(this.clock, options.versionGraceMs ?? 0);
    this.fixedConcurrency = options.chunkConcurrency;
    if (this.fixedConcurrency !== undefined)
      this.concurrency = this.fixedConcurrency;
  }

  /** The emitter every event of this executor goes through. */
  get sink(): EventSink {
    return this.events;
  }

  /** Resolves on the next change: a page planned, a chunk settled, a step advanced. */
  changed(): Promise<void> {
    return new Promise((resolve) => this.listeners.add(resolve));
  }

  private notify(): void {
    for (const l of this.listeners) l();
    this.listeners.clear();
    this.wakeUp?.();
  }

  /** The first error the loop or an advance hit, if any; a run's own failures are in the store. */
  get error(): unknown {
    return this.failure;
  }

  /** The first failure the executor hit, kept for `error` and `runToCompletion` to throw. */
  private recordFailure(err: unknown): void {
    this.failure ??= err;
  }

  async submit(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    const job = this.registry.get(run.jobKey);
    assertStoreHoldsValues(job, this.store);
    assertStoreSafeFor(job, this.store);
    this.remember(run);
    this.submitted.add(runId);
    if (this.fixedConcurrency === undefined)
      this.concurrency = Math.max(
        this.concurrency,
        run.chunkConcurrency ?? chunkConcurrencyFor(run.chunkSize),
      );
    this.kick(runId);
  }

  /** Advances a run, one advance at a time per run; a change while one runs queues one more. */
  private kick(runId: string): void {
    if (this.killer.signal.aborted) return;
    const current = this.advancing.get(runId);
    if (current) {
      current.again = true;
      return;
    }
    const entry = { again: false, done: Promise.resolve() };
    const deps: AdvanceDeps = {
      store: this.store,
      registry: this.registry,
      clock: this.clock,
      events: this.events,
      signal: this.killer.signal,
      limiters: this.limiters,
      stops: this.stops,
      pageSize: this.pageSize,
      onChange: () => this.notify(),
      submit: (id) => this.submit(id),
      versionGone: (run) => this.drain.gone(run),
    };
    entry.done = (async () => {
      // Across processes, one advancer per run: another executor holding the run's lease advances it now, and this
      // one leaves it (its sweep comes back to it, should that one stop).
      if (!(await this.takeLease(runId))) return;
      try {
        const target = await this.targetOf(runId);
        do {
          entry.again = false;
          await inScope(this.around, target, () => advanceRun(deps, runId));
        } while (entry.again && !this.killer.signal.aborted);
      } finally {
        await this.dropLease(runId);
      }
    })()
      .catch((err: unknown) => this.recordFailure(err))
      .finally(() => {
        this.advancing.delete(runId);
        // A kick between the loop's last check of `again` and here marked this entry: it still gets its advance.
        if (entry.again) this.kick(runId);
        this.notify();
      });
    this.advancing.set(runId, entry);
  }

  private remember(run: Run): void {
    this.targets.set(run.id, {
      runId: run.id,
      tenantId: run.tenantId,
      jobKey: run.jobKey,
    });
  }

  private async targetOf(runId: string): Promise<RunScopeTarget> {
    const known = this.targets.get(runId);
    if (known) return known;
    this.remember(await this.store.getRun(runId));
    return this.targets.get(runId) as RunScopeTarget;
  }

  /** Takes the run's advance lease when the store has leases; true when this executor may advance it. */
  private async takeLease(runId: string): Promise<boolean> {
    const leases = this.store.runLeases;
    if (!leases) return true;
    const lease = await leases.leaseRun(runId, this.owner, this.leaseTtlMs);
    if (!lease) return false;
    this.leases.set(runId, lease);
    return true;
  }

  /** Releases the run's lease after an advance; a crash (`kill`) leaves it to expire. */
  private async dropLease(runId: string): Promise<void> {
    const lease = this.leases.get(runId);
    if (!lease) return;
    this.leases.delete(runId);
    if (this.killer.signal.aborted) return;
    await this.store.runLeases?.releaseRunLease(lease);
  }

  /**
   * The open-run sweep: a page of the store's pending and running runs, each of a job this executor registers
   * advanced (the lease decides who, across processes). Paged past the last run read, so a long list is read in
   * turns. A run of another version is left alone inside the drain window, as BullMQ's sweep leaves it.
   */
  private async sweepOpen(): Promise<void> {
    const open = await this.store.openRunIds(IN_PROCESS_SWEEP_PAGE, await this.sweepCursors.get('open'));
    await this.sweepCursors.set('open', open.length < IN_PROCESS_SWEEP_PAGE ? undefined : open.at(-1));
    for (const runId of open) {
      if (this.advancing.has(runId)) continue;
      const run = await this.store.getRun(runId).catch(() => null);
      if (!run || !this.registry.has(run.jobKey)) continue;
      if (this.drain.standing(this.registry.get(run.jobKey), run) === 'leave') continue;
      this.remember(run);
      this.submitted.add(runId);
      this.kick(runId);
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.heartbeat = setInterval(
      () => void this.beat(),
      Math.max(10, Math.floor(this.claimTtlMs / 3)),
    );
    this.loop = this.drive().catch((err: unknown) => {
      this.recordFailure(err);
      this.notify();
    });
  }

  /**
   * The loop: a poll, then a wait. A poll that throws (a store call failed: a dropped connection) is reported and the
   * loop carries on at the next poll; it never stops on one, since a stopped loop would claim, sweep and wake nothing
   * while its heartbeat kept its leases from other processes.
   */
  private async drive(): Promise<void> {
    while (this.running) {
      let retryIn: number | null = null;
      try {
        retryIn = await this.poll();
      } catch (err) {
        this.warn(
          `@pattern-stack/jobs in-process: a poll failed, so the loop tries again at the next one: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // A stop that landed during the poll found no wait to wake: end now, not a poll later.
      if (!this.running) break;
      const woken = new AbortController();
      this.wakeUp = () => woken.abort();
      if (retryIn !== null)
        // Nothing to do until a chunk's backoff ends: wait on the clock, so a fake clock moves toward it, but never
        // longer than a poll, so work another process puts in a shared store isn't held up by this backoff.
        await this.clock
          .sleep(Math.min(retryIn, this.pollMs), woken.signal)
          // Woken early (new work arrived) or a sleep that rejects for any other reason only ends this wait: the
          // loop polls again either way.
          .then(
            () => undefined,
            () => undefined,
          );
      else
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.pollMs);
          woken.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        });
      this.wakeUp = null;
    }
  }

  /** One poll: expired claims, the open sweep (every `openSweepEvery`), due waits, claims. Returns the idle wait. */
  private async poll(): Promise<number | null> {
    await this.store.sweepExpired();
    if (this.polls++ % this.openSweepEvery === 0) await this.sweepOpen();
    await this.wakeDue();
    const room = this.concurrency - this.active.size;
    let claimed = 0;
    if (room > 0) {
      // Only chunks of jobs this executor can run: another job's, in a shared store, is never taken and failed.
      const claims = await this.store.claimChunks(
        this.owner,
        room,
        this.claimTtlMs,
        this.jobKeys,
      );
      claimed = claims.length;
      for (const claim of claims) this.launch(claim);
    }
    return claimed === 0 && this.active.size === 0 && this.advancing.size === 0
      ? await this.nextRetryIn()
      : null;
  }

  /**
   * The due waits, beside the sweep: each waiting run of a job this executor has whose step is due is advanced, and
   * the advance decides (carry on, or wait again). Paged past the last run woken, so a long list is read in turns.
   */
  private async wakeDue(): Promise<void> {
    const due = await this.store.dueRunIds(
      this.clock.now(),
      IN_PROCESS_SWEEP_PAGE,
      await this.sweepCursors.get('due'),
    );
    await this.sweepCursors.set('due', due.length < IN_PROCESS_SWEEP_PAGE ? undefined : due.at(-1));
    for (const runId of due) {
      // One run's read failing (deleted since the page) stays that run's: the rest are still woken.
      const run = await this.store.getRun(runId).catch(() => null);
      if (!run || !this.registry.has(run.jobKey)) continue;
      this.remember(run);
      this.submitted.add(runId);
      this.kick(runId);
    }
  }

  /**
   * How long until the earliest pending chunk, or the earliest due wait, of a run this executor drives, if any is
   * waiting on the clock.
   */
  private async nextRetryIn(): Promise<number | null> {
    const now = this.clock.now().getTime();
    let earliest: number | null = null;
    for (const runId of this.submitted) {
      // One run's read failing (a deleted run) is that run's: it is no longer driven.
      const at = await this.nextDueAt(runId, now).catch(() => {
        this.submitted.delete(runId);
        return null;
      });
      if (at !== null) earliest = Math.min(earliest ?? Infinity, at);
    }
    return earliest === null ? null : earliest - now;
  }

  /**
   * When a run next has work on the clock: a waiting run's earliest wake, a running run's earliest backed-off chunk.
   * A run that ended is no longer driven; a paused or pending one is kept for its resume.
   */
  private async nextDueAt(runId: string, now: number): Promise<number | null> {
    const run = await this.store.getRun(runId);
    if (run.status === 'waiting')
      return earliestOf(
        (await this.store.stepStates(runId)).flatMap((s) =>
          s.status === 'waiting' && s.wait?.wakeAt
            ? [Math.max(now, s.wait.wakeAt.getTime())]
            : [],
        ),
      );
    if (run.status === 'running')
      return earliestOf(
        (await this.store.chunks(runId)).flatMap((c) =>
          c.status === 'pending' && c.runAt.getTime() > now
            ? [c.runAt.getTime()]
            : [],
        ),
      );
    if (run.status !== 'paused' && run.status !== 'pending')
      this.submitted.delete(runId);
    return null;
  }

  private launch(claim: ChunkClaim): void {
    const id = `${claim.runId}/${claim.step}#${claim.index}`;
    const running = this.active.get(id);
    if (running) {
      // This executor still works the chunk under a claim the store swept: that worker is fenced out, so stop it,
      // and give the fresh claim back (no attempt spent) to be taken once it has ended.
      running.controller.abort(new Error('claim lost'));
      void this.store
        .releaseChunk(claim, { kind: 'yield' })
        .catch((err: unknown) => {
          if (!(err instanceof ClaimLostError)) this.recordFailure(err);
        });
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.killer.signal]);
    const deps: ChunkDeps = {
      store: this.store,
      registry: this.registry,
      clock: this.clock,
      events: this.events,
      signal,
      limiters: this.limiters,
      stops: this.stops,
    };
    const done = (async () => {
      try {
        const target = await this.targetOf(claim.runId);
        const outcome = await inScope(this.around, target, () =>
          processChunk(deps, claim),
        );
        // A shutdown without drain gives back only this executor's own chunks.
        if (
          outcome === 'aborted' &&
          this.stopping &&
          !this.killer.signal.aborted
        )
          await this.store
            .releaseChunk(claim, { kind: 'yield' })
            .catch((err: unknown) => {
              if (!(err instanceof ClaimLostError)) throw err;
            });
      } catch (err) {
        if (!this.killer.signal.aborted) this.recordFailure(err);
      } finally {
        this.active.delete(id);
        this.kick(claim.runId);
        this.notify();
      }
    })();
    this.active.set(id, { claim, controller, done });
  }

  private async beat(): Promise<void> {
    if (this.killer.signal.aborted) return;
    await this.renewLeases();
    const actives = [...this.active.values()];
    if (!actives.length) return;
    try {
      const report = await this.store.renewClaim(
        this.owner,
        actives.map((a) => a.claim),
        this.claimTtlMs,
      );
      // Matched by value (chunk and token), never by object identity: a store may rebuild claims from rows.
      const lost = new Set(report.lost.map(claimId));
      for (const a of actives)
        if (
          abortsInFlight(lost.has(claimId(a.claim)), report.runs[a.claim.runId])
        )
          a.controller.abort(new Error('claim lost, or the run ended'));
    } catch {
      // A failed renewal is not fatal: the claims may lapse, and the store's fence keeps a swept worker's writes out.
    }
  }

  /** Renews the advance leases this executor holds; a lost one is dropped (another process may advance the run). */
  private async renewLeases(): Promise<void> {
    const leases = this.store.runLeases;
    if (!leases || !this.leases.size) return;
    try {
      const { lost } = await leases.renewRunLeases(
        [...this.leases.values()],
        this.leaseTtlMs,
      );
      for (const l of lost)
        if (this.leases.get(l.runId)?.token === l.token)
          this.leases.delete(l.runId);
    } catch {
      // As a failed claim renewal: the lease may lapse; the next beat tries again.
    }
  }

  async stop(options: { drain?: boolean } = {}): Promise<void> {
    this.running = false;
    this.notify();
    await this.loop;
    if (options.drain === false) {
      this.stopping = true;
      for (const a of this.active.values())
        a.controller.abort(new Error('the executor is stopping'));
    }
    // Drain: every in-flight chunk settles itself (completed, retry or yield), then the last advances. The heartbeat
    // keeps renewing meanwhile, so a long chunk keeps its claim and still sees a cancel.
    await Promise.all([...this.active.values()].map((a) => a.done));
    // An advance that ends re-kicks its run when a kick landed late, so a new one can start after a snapshot: wait
    // until none is left.
    while (this.advancing.size)
      await Promise.all([...this.advancing.values()].map((a) => a.done));
    if (this.heartbeat) clearInterval(this.heartbeat);
  }

  /** Acts out a crash: in-flight calls are aborted, nothing settles, and every claim is left to expire. */
  async kill(): Promise<void> {
    this.killer.abort(new Error('killed'));
    this.running = false;
    this.notify();
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.loop;
    await Promise.all([...this.active.values()].map((a) => a.done));
    await Promise.all([...this.advancing.values()].map((a) => a.done));
  }
}

export interface RunToCompletionDeps {
  store: JobStore;
  /** The quotas steps name; default `localLimiters()`. */
  limiters?: Limiters;
  sinks?: readonly EventSink[];
  clock?: Clock;
  onProgress?: (progress: RunProgress) => void;
  /** Aborting acts out a crash (`kill`): the run stays where it was, ready to resume. */
  signal?: AbortSignal;
  /**
   * Scripted signals, for evals and tests: the value to send when the run waits on `step` for `signal` (sent by no
   * one, `by: null`), or undefined to send none. A wait no script answers and no timeout ends returns the run waiting.
   */
  signals?: (wait: { step: string; signal: string }) => unknown;
  executor?: Partial<
    Omit<
      InProcessOptions,
      'store' | 'registry' | 'limiters' | 'sinks' | 'clock'
    >
  >;
}

/** A job and every job its children steps start, down the tree: what `runToCompletion` registers. */
function withDescendants(job: AnyJob): AnyJob[] {
  const found = new Map<string, AnyJob>();
  const visit = (j: AnyJob) => {
    if (found.has(j.key)) return;
    found.set(j.key, j);
    for (const s of j.steps)
      if (s.erased.kind === 'children') visit(s.erased.job);
  };
  visit(job);
  return [...found.values()];
}

export interface RunOutcome<O> {
  run: Run;
  /** The job's output once the run completed; undefined while it is paused or waiting, or once it failed or was canceled. */
  output: O | undefined;
  steps: StepState[];
}

/**
 * Starts the run (or finds the open one on its dedupe key, to resume it), executes it in this process, and returns
 * once it completes, fails, is canceled or pauses, or waits on a signal nothing will send (see `signals`). Scripts and evals use it; outputs come from the store, so a
 * cached item reads the result an earlier run wrote.
 */
export async function runToCompletion<I, O>(
  job: JobDefinition<I, O, unknown>,
  request: Omit<RunRequest<NoInfer<I>>, 'jobKey'>,
  deps: RunToCompletionDeps,
): Promise<RunOutcome<O>> {
  const { store } = deps;
  const clock = deps.clock ?? systemClock;
  const registry = createRegistry(withDescendants(job));
  const executor = new InProcessExecutor({
    ...deps.executor,
    store,
    registry,
    limiters: deps.limiters,
    sinks: deps.sinks,
    clock,
  });
  const { run: created } = await startRun(
    { registry, store },
    { ...request, jobKey: job.key },
  );
  if (created.status === 'paused')
    await resumeRun({ store, clock, events: executor.sink }, created.id);
  const onAbort = () => void executor.kill();
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await executor.start();
    await executor.submit(created.id);
    for (;;) {
      const changed = executor.changed();
      const progress = await store.progress(created.id);
      deps.onProgress?.(progress);
      if (deps.signal?.aborted) {
        await executor.kill();
        throw deps.signal.reason;
      }
      if (executor.error) {
        await executor.kill();
        throw executor.error;
      }
      const { status } = progress.run;
      if (TERMINAL_RUN.includes(status) || status === 'paused') break;
      const waiting = progress.steps.find(
        (s) => s.status === 'waiting' && s.wait?.kind === 'signal',
      );
      if (status === 'waiting' && waiting?.wait) {
        const value = deps.signals?.({
          step: waiting.name,
          signal: waiting.wait.name,
        });
        if (value !== undefined)
          await signalRun(
            { store, registry, clock, events: executor.sink, executor },
            {
              runId: created.id,
              step: waiting.name,
              signal: waiting.wait.name,
              value,
              by: null,
            },
          );
        else if (!waiting.wait.wakeAt) break;
        else
          await Promise.race([
            changed,
            new Promise((r) => setTimeout(r, 1_000)),
          ]);
        continue;
      }
      // A change wakes this at once; the timeout covers a chunk waiting out its backoff.
      await Promise.race([changed, new Promise((r) => setTimeout(r, 1_000))]);
    }
    await executor.stop();
  } finally {
    deps.signal?.removeEventListener('abort', onAbort);
  }
  if (executor.error) throw executor.error;
  const { run, steps } = await store.progress(created.id);
  const output =
    run.status === 'completed'
      ? job.output.parse(await runOutputOf(store, job, run))
      : undefined;
  return { run, output, steps };
}
