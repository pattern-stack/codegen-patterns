/**
 * JobWorker — backend-agnostic tick loop for the job orchestration domain
 * (ADR-022, JOB-3).
 *
 * One worker instance per active pool. On `onModuleInit` it starts two
 * intervals: the poll loop (claim → process → repeat) and the stale-claim
 * sweeper. On `onModuleDestroy` / SIGTERM it drains in-flight work and
 * releases still-`running` rows back to `pending` so a replacement worker
 * can resume with step memoization intact.
 *
 * The claim query is the beating heart: `SELECT … FOR UPDATE SKIP LOCKED`
 * inside a single transaction. Multiple worker processes share the table
 * without serialising on row locks.
 */
// TODO(logging-subsystem): swap to ILogger once ADR-028 lands
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, asc, desc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import type { DrizzleClient } from '../../types/drizzle';
import { tokenKey } from '../token-key';
import { DRIZZLE } from '../../constants/tokens';
import { jobRuns, type JobRunRow } from './job-orchestration.schema';
import type { IJobOrchestrator, JobRun } from './job-orchestrator.protocol';
import type { IJobRunService } from './job-run-service.protocol';
import type { IJobStepService } from './job-step-service.protocol';
import {
  JOB_ORCHESTRATOR,
  JOB_RUN_SERVICE,
  JOB_STEP_SERVICE,
} from './jobs-domain.tokens';
import {
  JOB_HANDLER_REGISTRY,
  JobHandlerBase,
  type JobContext,
  type JobHandlerMeta,
  type RetryPolicy,
  type SpawnChildOptions,
  type StepOptions,
} from './job-handler.base';
import { JOBS_WAKE_CHANNEL, PgNotifyListener } from './pg-notify';

/**
 * Options accepted by `JobWorker`. JOB-5 threads these through module
 * `.forRoot()` config; supplied here as a plain DI-constructor argument
 * so the worker compiles standalone.
 */
export interface JobWorkerOptions {
  /** Pool name this worker claims from. Matches `job.pool`. */
  pool: string;
  /** Max concurrent in-flight `processRun` calls. */
  concurrency: number;
  /** Poll interval in ms. Default 1000. */
  pollIntervalMs?: number;
  /** Stale sweep interval in ms. Default 60_000. */
  staleSweeperIntervalMs?: number;
  /**
   * Threshold beyond which a `running` row is presumed stranded by a
   * crashed worker. Default 5 min. Must be >= 2× max handler duration.
   */
  staleThresholdMs?: number;
  /** Max ms to wait for in-flight drain on SIGTERM. Default 30_000. */
  shutdownTimeoutMs?: number;
  /**
   * LISTEN-NOTIFY-1 — when true, hold a dedicated listener connection and
   * LISTEN on `codegen_jobs_wake`. A notification naming this worker's `pool`
   * triggers an immediate (debounced) claim cycle, so an enqueue is claimed in
   * milliseconds instead of waiting for the next `pollIntervalMs` tick. Polling
   * continues unchanged as the fallback heartbeat. Default false.
   */
  listenNotify?: boolean;
}

// ADR-037: namespaced `Symbol.for(...)` (via `tokenKey()`) — matches by value
// across runtime copies.
export const JOB_WORKER_OPTIONS = Symbol.for(tokenKey('jobs', 'worker-options'));

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STALE_SWEEPER_INTERVAL_MS = 60_000;
const DEFAULT_STALE_THRESHOLD_MS = 5 * 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

const TERMINAL_STATUSES: JobRunRow['status'][] = [
  'completed',
  'failed',
  'timed_out',
  'canceled',
];

// ─── Pure helpers (exported for unit tests) ────────────────────────────────

/**
 * Backoff delay in ms for the Nth attempt (1-indexed). Supports both
 * policy modes. Exponential is capped at `Number.MAX_SAFE_INTEGER` so
 * pathological attempt counts don't overflow.
 */
export function computeBackoff(policy: RetryPolicy, attempts: number): number {
  const base = Math.max(policy.baseMs, 0);
  if (policy.backoff === 'fixed') {
    return base;
  }
  // exponential: baseMs * 2^(attempts-1)
  const exponent = Math.max(attempts - 1, 0);
  if (exponent >= 53) return Number.MAX_SAFE_INTEGER; // 2^53 overflow guard
  const raw = base * Math.pow(2, exponent);
  if (!Number.isFinite(raw) || raw >= Number.MAX_SAFE_INTEGER) {
    return Number.MAX_SAFE_INTEGER;
  }
  return raw;
}

/**
 * Decide whether an error should be retried under the given policy.
 * Matches `nonRetryableErrors` by `.name` OR `.code`. Returns
 *   - `'retry'` if attempts remain and the error isn't blacklisted,
 *   - `'fail'` otherwise (terminal failure).
 */
export function classifyError(
  err: unknown,
  policy: RetryPolicy | undefined,
  currentAttempts: number,
): 'retry' | 'fail' {
  if (!policy) return 'fail';
  const errObj = err as { name?: string; code?: string } | undefined;
  const name = errObj?.name;
  const code = errObj?.code;
  const nonRetryable = policy.nonRetryableErrors ?? [];
  if (nonRetryable.some((n) => n === name || n === code)) return 'fail';
  if (currentAttempts + 1 >= policy.attempts) return 'fail';
  return 'retry';
}

/**
 * Build the raw claim-candidate select. Exported so tests can inspect
 * `.toSQL()` without spinning up the full worker. Matches JOB-3 §4 and
 * ADR-022 "Claim query (Drizzle backend)".
 */
export function buildClaimQuery(db: DrizzleClient, pool: string) {
  return db
    .select({ id: jobRuns.id })
    .from(jobRuns)
    .where(
      and(
        eq(jobRuns.status, 'pending'),
        eq(jobRuns.pool, pool),
        lte(jobRuns.runAt, new Date()),
      ),
    )
    .orderBy(desc(jobRuns.priority), asc(jobRuns.runAt))
    .limit(1)
    .for('update', { skipLocked: true });
}

/**
 * Build the stale-claim sweep candidate select. `FOR UPDATE SKIP LOCKED`
 * per OQ-2 resolution (2026-04-19): per-worker sweeper, safe without
 * leader election because the update is self-gating.
 */
export function buildStaleSweepQuery(
  db: DrizzleClient,
  staleThresholdMs: number,
) {
  const threshold = new Date(Date.now() - staleThresholdMs);
  return db
    .select({ id: jobRuns.id })
    .from(jobRuns)
    .where(
      and(
        eq(jobRuns.status, 'running'),
        lt(jobRuns.claimedAt, threshold),
      ),
    )
    .for('update', { skipLocked: true });
}

// ─── Error serialisation ───────────────────────────────────────────────────

function serialiseError(err: unknown, attempt: number, retryable: boolean) {
  const e = err as { message?: string; stack?: string; code?: string } | undefined;
  return {
    message: (e?.message ?? String(err)) as string,
    stack: e?.stack,
    retryable,
    attempt,
  };
}

// ─── JobWorker ─────────────────────────────────────────────────────────────

@Injectable()
export class JobWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobWorker.name);
  private shuttingDown = false;
  private readonly inFlight = new Set<Promise<void>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sweeperTimer: ReturnType<typeof setInterval> | null = null;
  private sigtermHandled = false;
  private readonly sigtermHandler: () => void;

  private readonly pollIntervalMs: number;
  private readonly staleSweeperIntervalMs: number;
  private readonly staleThresholdMs: number;
  private readonly shutdownTimeoutMs: number;

  // LISTEN-NOTIFY-1 — dedicated listener + debounce state. `null` when
  // `listenNotify` is off (the common case); polling is the only driver then.
  private readonly listenNotifyEnabled: boolean;
  private notifyListener: PgNotifyListener | null = null;
  /** True while a wake-driven claim cycle is in flight (debounce gate). */
  private wakeDraining = false;
  /** A notify arrived mid-cycle → re-check once when the cycle ends. */
  private wakeRecheckPending = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
    @Inject(JOB_ORCHESTRATOR) private readonly orchestrator: IJobOrchestrator,
    @Inject(JOB_RUN_SERVICE) private readonly runService: IJobRunService,
    @Inject(JOB_STEP_SERVICE) private readonly stepService: IJobStepService,
    @Inject(JOB_WORKER_OPTIONS) private readonly options: JobWorkerOptions,
    private readonly moduleRef: ModuleRef,
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.staleSweeperIntervalMs =
      options.staleSweeperIntervalMs ?? DEFAULT_STALE_SWEEPER_INTERVAL_MS;
    this.staleThresholdMs = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.listenNotifyEnabled = options.listenNotify ?? false;

    this.sigtermHandler = () => {
      if (this.sigtermHandled) return;
      this.sigtermHandled = true;
      void this.onModuleDestroy();
    };
    void this.runService; // reserved for future scope-aware cancellation paths
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  onModuleInit(): void {
    this.pollTimer = setInterval(() => {
      void this.pollAndProcess();
    }, this.pollIntervalMs);
    this.sweeperTimer = setInterval(() => {
      void this.sweepStaleClaims();
    }, this.staleSweeperIntervalMs);
    process.on('SIGTERM', this.sigtermHandler);

    // LISTEN-NOTIFY-1 — start the wake listener ALONGSIDE the poll timer (never
    // instead). A notify for this worker's pool drives an immediate claim cycle;
    // the interval timer above stays the durability heartbeat. Listener startup
    // is fire-and-forget: a connect failure self-heals via the listener's own
    // backoff, and until it's up the poll loop is the sole driver.
    if (this.listenNotifyEnabled) {
      // The DRIZZLE provider wraps a `pg.Pool`, exposed by drizzle as `$client`.
      const pool = (this.db as unknown as { $client?: unknown }).$client;
      if (!pool || typeof (pool as { connect?: unknown }).connect !== 'function') {
        this.logger.warn(
          `listen_notify enabled but the Drizzle client exposes no pg Pool ` +
            `($client.connect missing) — falling back to interval polling only.`,
        );
      } else {
        this.notifyListener = new PgNotifyListener({
          channel: JOBS_WAKE_CHANNEL,
          pool: pool as { connect(): Promise<never> },
          label: `jobs:${this.options.pool}`,
          onNotify: (payload) => this.onWake(payload),
        });
        void this.notifyListener.start();
      }
    }
  }

  /**
   * Wake handler — a `codegen_jobs_wake` notification arrived. Only payloads
   * naming THIS worker's pool are relevant (other pools have their own workers).
   * Debounced: if a claim cycle is already running we just flag a re-check so a
   * burst of N enqueues collapses to at most one extra cycle (D3).
   */
  private onWake(payload: string): void {
    if (this.shuttingDown) return;
    if (payload !== this.options.pool) return;
    if (this.wakeDraining) {
      this.wakeRecheckPending = true;
      return;
    }
    void this.drainOnWake();
  }

  /**
   * Claim-until-empty on a wake. Unlike the interval `pollAndProcess` (one
   * claim per tick), a wake drains greedily up to the concurrency ceiling so a
   * burst that arrived together is dispatched without waiting for N ticks. The
   * `wakeRecheckPending` flag coalesces notifies that land mid-drain.
   */
  private async drainOnWake(): Promise<void> {
    this.wakeDraining = true;
    try {
      do {
        this.wakeRecheckPending = false;
        // Claim while there's capacity; pollAndProcess no-ops at the ceiling.
        let progressed = true;
        while (
          progressed &&
          !this.shuttingDown &&
          this.inFlight.size < this.options.concurrency
        ) {
          const before = this.inFlight.size;
          await this.pollAndProcess();
          progressed = this.inFlight.size > before;
        }
      } while (this.wakeRecheckPending && !this.shuttingDown);
    } finally {
      this.wakeDraining = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    // LISTEN-NOTIFY-2 — release the listener connection on EVERY destroy path,
    // including the `shuttingDown` early-return below (reached when SIGTERM and
    // Nest's onModuleDestroy both fire) and a destroy with no prior SIGTERM.
    // Previously this lived only on the first (non-shuttingDown) branch, so a
    // double-fire — or a stop() that raced the listener's own in-flight
    // connect() — left a `LISTEN codegen_jobs_wake` socket open past
    // `app.close()`, hanging the process. `PgNotifyListener.stop()` is itself
    // idempotent + connect-race-safe (LISTEN-NOTIFY-2). Best-effort; a failure
    // here doesn't block the drain.
    await this.stopNotifyListener();

    if (this.shuttingDown) {
      // Still drain, but don't tear intervals down twice.
      await this.drainInFlight();
      return;
    }
    this.shuttingDown = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = null;
    }
    process.removeListener('SIGTERM', this.sigtermHandler);

    await this.drainInFlight();

    // Any rows still `running` past timeout → release back to pending.
    try {
      await this.db
        .update(jobRuns)
        .set({ status: 'pending', claimedAt: null, startedAt: null })
        .where(
          and(eq(jobRuns.status, 'running'), eq(jobRuns.pool, this.options.pool)),
        );
    } catch (err) {
      this.logger.error(`shutdown reset failed: ${(err as Error).message}`);
    }
  }

  private async drainInFlight(): Promise<void> {
    if (this.inFlight.size === 0) return;
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, this.shutdownTimeoutMs),
    );
    await Promise.race([
      Promise.allSettled([...this.inFlight]).then(() => undefined),
      timeout,
    ]);
  }

  /**
   * LISTEN-NOTIFY-2 — stop + drop the wake listener. Idempotent: a second call
   * (SIGTERM + Nest destroy) finds `notifyListener` already null and no-ops.
   * `PgNotifyListener.stop()` is itself race-safe against an in-flight
   * `connect()`, so even a destroy that arrives microseconds after `start()`
   * releases the listener socket rather than leaking it.
   */
  private async stopNotifyListener(): Promise<void> {
    const listener = this.notifyListener;
    if (!listener) return;
    this.notifyListener = null;
    try {
      await listener.stop();
    } catch (err) {
      this.logger.error(`notify listener stop failed: ${(err as Error).message}`);
    }
  }

  // ============================================================================
  // Poll loop
  // ============================================================================

  async pollAndProcess(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.inFlight.size >= this.options.concurrency) return;

    let claimed: JobRunRow | null;
    try {
      claimed = await this.claimNext(this.options.pool);
    } catch (err) {
      this.logger.error(`claimNext failed: ${(err as Error).message}`);
      return;
    }
    if (!claimed) return;

    const run = claimed;
    const promise = this.processRun(run).catch((err) => {
      this.logger.error(
        `processRun(${run.id}) unhandled: ${(err as Error).message}`,
      );
    });
    this.inFlight.add(promise);
    promise.finally(() => {
      this.inFlight.delete(promise);
    });
  }

  /**
   * Claim the next runnable row from the pool. Transaction ensures the
   * select-candidate + update-to-running pair is atomic; FOR UPDATE SKIP
   * LOCKED lets multiple workers share the table without serialising.
   */
  async claimNext(pool: string): Promise<JobRunRow | null> {
    return this.db.transaction(async (tx) => {
      const candidates = await tx
        .select({ id: jobRuns.id })
        .from(jobRuns)
        .where(
          and(
            eq(jobRuns.status, 'pending'),
            eq(jobRuns.pool, pool),
            lte(jobRuns.runAt, new Date()),
          ),
        )
        .orderBy(desc(jobRuns.priority), asc(jobRuns.runAt))
        .limit(1)
        .for('update', { skipLocked: true });
      const candidate = candidates[0];
      if (!candidate) return null;

      const [claimed] = await tx
        .update(jobRuns)
        .set({
          status: 'running',
          claimedAt: new Date(),
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(jobRuns.id, candidate.id))
        .returning();
      return (claimed ?? null) as JobRunRow | null;
    });
  }

  // ============================================================================
  // Stale claim sweeper
  // ============================================================================

  /**
   * Release rows whose `claimed_at` is older than the threshold. Safe to
   * run concurrently across workers — the two-phase tx (select-for-update
   * then update) guarantees each stranded row is only reset once.
   */
  async sweepStaleClaims(): Promise<void> {
    if (this.shuttingDown) return;
    try {
      await this.db.transaction(async (tx) => {
        const threshold = new Date(Date.now() - this.staleThresholdMs);
        const stale = await tx
          .select({ id: jobRuns.id })
          .from(jobRuns)
          .where(
            and(eq(jobRuns.status, 'running'), lt(jobRuns.claimedAt, threshold)),
          )
          .for('update', { skipLocked: true });
        if (stale.length === 0) return;
        const ids = stale.map((r) => r.id);
        await tx
          .update(jobRuns)
          .set({ status: 'pending', claimedAt: null, startedAt: null })
          .where(inArray(jobRuns.id, ids));
        for (const id of ids) {
          this.logger.warn(`Recovered stale claim on run ${id}`);
        }
      });
    } catch (err) {
      this.logger.error(`sweepStaleClaims failed: ${(err as Error).message}`);
    }
  }

  // ============================================================================
  // processRun
  // ============================================================================

  private async processRun(claimed: JobRunRow): Promise<void> {
    const registryEntry = JOB_HANDLER_REGISTRY.get(claimed.jobType);

    // (a) Missing handler — defensive; JOB-5 boot validator should have caught.
    if (!registryEntry) {
      this.logger.error(
        `No handler registered for jobType='${claimed.jobType}' (run ${claimed.id})`,
      );
      await this.markFailed(
        claimed,
        new Error(`No handler registered for jobType='${claimed.jobType}'`),
        /*finalAttempts*/ (claimed.attempts ?? 0) + 1,
      );
      return;
    }

    // (b) Concurrency-queue release gate — defer if another run with the
    //     same key is already `running`.
    if (claimed.concurrencyKey) {
      const inflight = await this.db
        .select({ id: jobRuns.id })
        .from(jobRuns)
        .where(
          and(
            eq(jobRuns.concurrencyKey, claimed.concurrencyKey),
            eq(jobRuns.status, 'running'),
          ),
        );
      const other = inflight.find((r) => r.id !== claimed.id);
      if (other) {
        await this.db
          .update(jobRuns)
          .set({
            status: 'pending',
            claimedAt: null,
            startedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(jobRuns.id, claimed.id));
        return;
      }
    }

    const meta = registryEntry.meta as JobHandlerMeta<unknown>;
    const HandlerClass = registryEntry.handlerClass;

    // (c) Build JobContext. Resolve the handler instance from Nest's DI
    //     graph so its `@Inject` constructor params (which may come from
    //     any module in the app graph) are satisfied. `moduleRef.create()`
    //     would otherwise instantiate a fresh class within JobWorkerModule's
    //     scope only — which blows up with "not a provider of the current
    //     module" for any handler that consumes a service from a peer
    //     module (e.g. CrmSyncJob injecting CrmSyncFactory from CrmModule).
    //     Consequence: handlers MUST be registered as providers in their
    //     owning module (@Injectable + `providers: [HandlerClass]`). The
    //     @JobHandler decorator handles registry registration only, not DI.
    //     See the jobs skill's handler-authoring.md for the registration
    //     rule.
    const handler = this.moduleRef.get(
      HandlerClass as unknown as new (...args: unknown[]) => unknown,
      { strict: false },
    ) as JobHandlerBase<unknown>;
    const ctx: JobContext<unknown> = {
      input: claimed.input,
      run: claimed as JobRun,
      step: this.makeStepFn(claimed),
      spawnChild: this.makeSpawnFn(claimed),
      logger: new Logger(`JobRun:${claimed.id}`),
    };

    const attemptsBefore = claimed.attempts ?? 0;
    try {
      // (d) Run the handler.
      const output = (await handler.run(ctx)) as Record<string, unknown> | undefined;
      // (e) Success.
      await this.db
        .update(jobRuns)
        .set({
          status: 'completed',
          output: (output ?? {}) as Record<string, unknown>,
          finishedAt: new Date(),
          updatedAt: new Date(),
          attempts: attemptsBefore + 1,
        })
        .where(eq(jobRuns.id, claimed.id));
    } catch (err) {
      // (f) Error classification + retry/fail.
      const policy = meta.retry;
      const decision = classifyError(err, policy, attemptsBefore);
      const nextAttempts = attemptsBefore + 1;
      if (decision === 'retry' && policy) {
        const delay = computeBackoff(policy, nextAttempts);
        await this.db
          .update(jobRuns)
          .set({
            status: 'pending',
            attempts: nextAttempts,
            runAt: new Date(Date.now() + delay),
            startedAt: null,
            claimedAt: null,
            error: serialiseError(err, nextAttempts, true),
            updatedAt: new Date(),
          })
          .where(eq(jobRuns.id, claimed.id));
      } else {
        await this.markFailed(claimed, err, nextAttempts);
      }
    }
  }

  private async markFailed(
    claimed: JobRunRow,
    err: unknown,
    finalAttempts: number,
  ): Promise<void> {
    await this.db
      .update(jobRuns)
      .set({
        status: 'failed',
        attempts: finalAttempts,
        finishedAt: new Date(),
        error: serialiseError(err, finalAttempts, false),
        updatedAt: new Date(),
      })
      .where(eq(jobRuns.id, claimed.id));

    // Parent-close-policy cascade: if this run has children under the same
    // root_run_id and this run's own parentClosePolicy is 'terminate', cascade.
    if (claimed.parentClosePolicy === 'terminate') {
      try {
        // JOB-8 — thread the run's own tenantId so the orchestrator's
        // multi-tenant gate passes. Without this, every terminate-policy
        // cascade throws MissingTenantIdError under multiTenant=true and
        // the outer catch silently swallows it — children never cancel.
        await this.orchestrator.cancel(claimed.id, {
          cascade: true,
          reason: 'parent-failed',
          tenantId: claimed.tenantId,
        });
      } catch (cascadeErr) {
        // cancel is idempotent; failure here is unusual but not fatal.
        this.logger.warn(
          `cascade on failed run ${claimed.id}: ${(cascadeErr as Error).message}`,
        );
      }
    }
  }

  // ============================================================================
  // ctx.step / ctx.spawnChild builders
  // ============================================================================

  private makeStepFn(run: JobRunRow) {
    return async <TOutput>(
      stepId: string,
      fn: () => Promise<TOutput>,
      _opts?: StepOptions,
    ): Promise<TOutput> => {
      void _opts;
      const existing = await this.stepService.findStep(run.id, stepId);
      if (existing?.status === 'completed') {
        return existing.output as TOutput;
      }

      const seq = await this.nextStepSeq(run.id);
      const startedAt = new Date();
      const nextAttempts = (existing?.attempts ?? 0) + 1;
      await this.stepService.recordStep({
        jobRunId: run.id,
        stepId,
        kind: 'task',
        seq,
        status: 'running',
        startedAt,
        attempts: nextAttempts,
      });
      try {
        const output = await fn();
        await this.stepService.recordStep({
          jobRunId: run.id,
          stepId,
          kind: 'task',
          seq,
          status: 'completed',
          output: output as Record<string, unknown> | undefined,
          finishedAt: new Date(),
          attempts: nextAttempts,
        });
        return output;
      } catch (err) {
        await this.stepService.recordStep({
          jobRunId: run.id,
          stepId,
          kind: 'task',
          seq,
          status: 'failed',
          error: serialiseError(err, nextAttempts, false),
          finishedAt: new Date(),
          attempts: nextAttempts,
        });
        throw err;
      }
    };
  }

  private makeSpawnFn(run: JobRunRow) {
    return async (
      type: string,
      input: unknown,
      opts?: SpawnChildOptions,
    ): Promise<JobRun> => {
      return this.orchestrator.start(type, input, {
        parentRunId: run.id,
        parentClosePolicy: opts?.closePolicy,
        runAt: opts?.runAt,
        priority: opts?.priority,
        tags: opts?.tags,
        triggerSource: 'parent',
        triggerRef: run.id,
      });
    };
  }

  /**
   * Allocate the next `seq` for a given run. SELECT-max approach — runs
   * typically have <100 steps so the scan is cheap, and correctness across
   * retries is more important than the microseconds saved by an in-memory
   * counter (which would drift if the worker crashes mid-run and another
   * worker resumes via stale-claim sweep).
   */
  private async nextStepSeq(runId: string): Promise<number> {
    const result = await this.db.execute(
      sql`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM job_step WHERE job_run_id = ${runId}`,
    );
    // Driver shape varies and is NOT uniformly array-iterable, so we must
    // never array-destructure the raw result (that throws `{} is not iterable`
    // on the node-postgres `Result` object, which exposes `.rows` instead of
    // being an array — first hit by package-mode bridge deliveries on
    // `drizzle-orm/node-postgres`). Normalise to a row array first, then read.
    //   - node-postgres `db.execute(sql)` → `{ rows: [{ next }], ... }`
    //   - some drivers / future shapes → a plain `[{ next }]` array
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = result as any;
    const rows: Array<{ next?: unknown }> = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.rows)
        ? raw.rows
        : [];
    const next = rows[0]?.next;
    return typeof next === 'undefined' ? 1 : Number(next);
  }

  // ============================================================================
  // (suppress unused-import noise)
  // ============================================================================
}

// Terminal statuses re-exported for JOB-4 parity imports.
export { TERMINAL_STATUSES };
