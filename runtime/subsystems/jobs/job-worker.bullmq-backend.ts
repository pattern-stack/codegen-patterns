/**
 * BullMQJobWorker — BullMQ-backed claim/dispatch worker (BULLMQ-1).
 *
 * Replaces the Drizzle `JobWorker` polling loop with one BullMQ `Worker` per
 * active pool. BullMQ owns claim (its native atomic BRPOPLPUSH), concurrency
 * (`{ concurrency }`), and retry/backoff (job opts set by the orchestrator) —
 * so this class is thinner than the Drizzle poller: no claim query, no stale
 * sweeper, no backoff math.
 *
 * The processor still drives the domain through Postgres `job_run` (the
 * source of truth) and runs the user handler through the existing
 * `JobHandlerBase` contract (`ctx.input` / `ctx.step` / `ctx.spawnChild`),
 * identical to the Drizzle path — only the claim mechanism differs.
 *
 *   BullMQ job (runId) → load job_run → mark running → resolve handler via
 *   ModuleRef → run(ctx) → mark completed / let BullMQ retry on throw.
 *
 * On a thrown handler error we rethrow so BullMQ applies the job's `attempts`/
 * `backoff` policy; the final failure (attempts exhausted) is mirrored to
 * `job_run.status='failed'` in the `failed` event handler.
 */
import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
// `bullmq` is an OPTIONAL peer dependency — TYPE imports ONLY here. `Worker`,
// `Job`, `ConnectionOptions` are erased at compile time and never resolve
// `'bullmq'` at runtime. The `Worker` VALUE constructor is loaded lazily via
// `await import('bullmq')` in `onModuleInit` (mirrors
// the events `event-scheduler.bullmq-backend.ts` loader). See BULLMQ-1 §Lazy import.
import type { Worker, Job, ConnectionOptions } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleClient } from '../../types/drizzle';
import { jobRuns, type JobRunRow } from './job-orchestration.schema';
import type { IJobOrchestrator, JobRun } from './job-orchestrator.protocol';
import type { IJobStepService } from './job-step-service.protocol';
import {
  JOB_HANDLER_REGISTRY,
  type JobContext,
  type JobHandlerBase,
  type SpawnChildOptions,
  type StepOptions,
} from './job-handler.base';

interface BullJobPayload {
  runId: string;
  type: string;
  input: unknown;
}

/**
 * How long to delay a run that lost the `collisionMode:'queue'` gate before
 * BullMQ re-offers it. Mirrors the Drizzle worker's release-to-pending +
 * re-claim-on-next-poll cadence (job-worker.ts:627-652); the active same-key
 * run has usually transitioned by the time the job comes back.
 */
const COLLISION_REQUEUE_DELAY_MS = 1_000;

function serialiseError(err: unknown, attempt: number, retryable: boolean) {
  const e = err as { message?: string; stack?: string } | undefined;
  return {
    message: (e?.message ?? String(err)) as string,
    stack: e?.stack,
    retryable,
    attempt,
  };
}

/**
 * Options for a single per-pool BullMQ worker.
 */
export interface BullMQJobWorkerOptions {
  /** Logical pool name (matches `job_run.pool`). */
  pool: string;
  /** Fully-resolved BullMQ queue name to consume. */
  queueName: string;
  /** Max concurrent in-flight processors. */
  concurrency: number;
  /** ioredis-compatible connection. */
  connection: ConnectionOptions;
}

export class BullMQJobWorker {
  private readonly logger = new Logger(BullMQJobWorker.name);
  private worker: Worker | null = null;
  /**
   * Cached `bullmq` `DelayedError` constructor. Thrown (after `moveToDelayed`)
   * to tell BullMQ a job was deliberately deferred by the `collisionMode:
   * 'queue'` gate — NOT failed, and NOT counting against `attempts`. Loaded
   * lazily in `onModuleInit` alongside `Worker` (optional peer dep).
   */
  private DelayedErrorCtor: (new () => Error) | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly orchestrator: IJobOrchestrator,
    private readonly stepService: IJobStepService,
    private readonly options: BullMQJobWorkerOptions,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit(): Promise<void> {
    let WorkerCtor: typeof import('bullmq').Worker;
    try {
      const mod = await import('bullmq');
      WorkerCtor = mod.Worker;
      this.DelayedErrorCtor = mod.DelayedError as unknown as new () => Error;
    } catch {
      throw new Error(
        'BullMQ backend requires the "bullmq" package. Install it with: npm install bullmq',
      );
    }
    this.worker = new WorkerCtor(
      this.options.queueName,
      // #6 / noImplicitAny — explicit annotations so the file stays
      // strict-clean even when consumers compile under a stricter tsconfig
      // than the one used to type-check the runtime tree. `token` is the
      // BullMQ lock token, needed by `moveToDelayed` in the collision gate.
      (job: Job<BullJobPayload>, token?: string) => this.process(job, token),
      {
        connection: this.options.connection,
        concurrency: this.options.concurrency,
      },
    );
    this.worker.on('failed', (job: Job<BullJobPayload> | undefined, err: Error) => {
      // BullMQ fires `failed` after EACH attempt; only mirror to job_run when
      // attempts are exhausted (BullMQ will not retry further).
      if (!job) return;
      const attemptsMade = job.attemptsMade;
      const maxAttempts = job.opts.attempts ?? 1;
      if (attemptsMade >= maxAttempts) {
        // Never let a DB hiccup here become an unhandled rejection (Node v15+
        // terminates the process) — the run would also be stranded in 'running'
        // (no stale-claim sweeper on the BullMQ worker; reconcilePending only
        // touches 'pending'). markFailed is internally guarded; this is the
        // final backstop.
        void this.markFailed(job.data.runId, err, attemptsMade).catch((e) =>
          this.logger.error(
            `markFailed(${job.data.runId}) failed: ${(e as Error).message}`,
          ),
        );
      }
    });
    this.logger.log(
      `BullMQ worker started: pool='${this.options.pool}' queue='${this.options.queueName}' concurrency=${this.options.concurrency}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }

  /**
   * Process one BullMQ job. Returns the handler output (stored by BullMQ as
   * the job return value AND written to `job_run.output`). Throws on handler
   * failure so BullMQ applies the retry policy.
   */
  private async process(job: Job<BullJobPayload>, token?: string): Promise<unknown> {
    const { runId } = job.data;
    const [row] = await this.db
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.id, runId))
      .limit(1);
    if (!row) {
      // Domain row vanished (canceled + removed). Treat as a no-op success so
      // BullMQ doesn't retry a job whose authoritative state is gone.
      this.logger.warn(`process: job_run ${runId} not found; skipping`);
      return {};
    }
    const run = row as JobRunRow;

    // Canceled in Postgres after enqueue but before claim — honour the domain
    // decision and skip without running the handler.
    if (run.status === 'canceled') {
      return {};
    }

    const registryEntry = JOB_HANDLER_REGISTRY.get(run.jobType);
    if (!registryEntry) {
      throw new Error(
        `No handler registered for jobType='${run.jobType}' (run ${run.id})`,
      );
    }

    // collisionMode:'queue' gate + mark-running, ATOMIC. Serialize same-
    // concurrency-key runs (the orchestrator inserted the second pending row on
    // collision — DrizzleJobOrchestrator.start `case 'queue'`; the worker is
    // what actually serializes execution). BullMQ claims up to `concurrency`
    // jobs at once, so a plain "is another running?" check before marking
    // running races: two same-key processors both read zero-running and both
    // proceed. `claimConcurrencyLane` closes that race with a per-key Postgres
    // advisory xact lock so the check + the `status='running'` mark happen
    // atomically — at most one same-key run is ever `running`. When the lane is
    // taken we DEFER: BullMQ has no "unclaim", so `moveToDelayed` + a thrown
    // `DelayedError` re-offers the job after a short delay WITHOUT marking it
    // failed or consuming an attempt. `token` is always present for a live
    // worker; the `&& token` guard keeps the call type-safe.
    if (run.concurrencyKey && token) {
      const claimed = await this.claimConcurrencyLane(run, job.attemptsMade + 1);
      if (!claimed) {
        await job.moveToDelayed(Date.now() + COLLISION_REQUEUE_DELAY_MS, token);
        if (this.DelayedErrorCtor) throw new this.DelayedErrorCtor();
        // Defensive: ctor not loaded (should never happen post-onModuleInit).
        return {};
      }
      // The run is now `running` (marked atomically inside the lane claim).
    } else {
      // No concurrency key → mark running directly.
      await this.db
        .update(jobRuns)
        .set({
          status: 'running',
          claimedAt: new Date(),
          startedAt: new Date(),
          attempts: job.attemptsMade + 1,
          updatedAt: new Date(),
        })
        .where(eq(jobRuns.id, run.id));
    }

    const HandlerClass = registryEntry.handlerClass;
    const handler = this.moduleRef.get(
      HandlerClass as unknown as new (...args: unknown[]) => unknown,
      { strict: false },
    ) as JobHandlerBase<unknown>;

    const ctx: JobContext<unknown> = {
      input: run.input,
      run: run as JobRun,
      step: this.makeStepFn(run),
      spawnChild: this.makeSpawnFn(run),
      logger: new Logger(`JobRun:${run.id}`),
    };

    const output = (await handler.run(ctx)) as
      | Record<string, unknown>
      | undefined;

    await this.db
      .update(jobRuns)
      .set({
        status: 'completed',
        output: (output ?? {}) as Record<string, unknown>,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(jobRuns.id, run.id));

    return output ?? {};
  }

  private async markFailed(
    runId: string,
    err: unknown,
    finalAttempts: number,
  ): Promise<void> {
    let run: JobRunRow;
    try {
      const [row] = await this.db
        .select()
        .from(jobRuns)
        .where(eq(jobRuns.id, runId))
        .limit(1);
      if (!row) return;
      run = row as JobRunRow;
      await this.db
        .update(jobRuns)
        .set({
          status: 'failed',
          attempts: finalAttempts,
          finishedAt: new Date(),
          error: serialiseError(err, finalAttempts, false),
          updatedAt: new Date(),
        })
        .where(eq(jobRuns.id, runId));
    } catch (dbErr) {
      // A DB failure stamping the terminal status would otherwise strand the
      // run in 'running' (no stale-claim sweeper on this worker). Log loudly so
      // it's visible; the caller's .catch is the unhandled-rejection backstop.
      this.logger.error(
        `markFailed: could not stamp 'failed' for run ${runId}: ${(dbErr as Error).message}`,
      );
      return;
    }

    // Parent-close-policy cascade — identical semantics to the Drizzle worker.
    if (run.parentClosePolicy === 'terminate') {
      try {
        await this.orchestrator.cancel(run.id, {
          cascade: true,
          reason: 'parent-failed',
          tenantId: run.tenantId,
        });
      } catch (cascadeErr) {
        this.logger.warn(
          `cascade on failed run ${run.id}: ${(cascadeErr as Error).message}`,
        );
      }
    }
  }

  /**
   * Atomically claim the concurrency lane for a `collisionMode:'queue'` run.
   * Returns `true` if this run took the lane (and was marked `running` in the
   * same tx), `false` if another same-key run already holds it (caller defers).
   *
   * A per-key `pg_advisory_xact_lock` serialises concurrent same-key claims:
   * without it, two BullMQ processors claimed at once both read "no same-key
   * run is running" before either marks running, and both proceed (the
   * check-then-act race that a plain SELECT-then-UPDATE cannot close). The lock
   * is keyed by a 64-bit hash of the concurrency key (`hashtextextended`), so
   * only same-key claims contend; it releases on commit/rollback. Hash
   * collisions merely over-serialise two unrelated keys — never a correctness
   * loss.
   */
  private async claimConcurrencyLane(
    run: JobRunRow,
    attempts: number,
  ): Promise<boolean> {
    const key = run.concurrencyKey;
    if (!key) return true; // no key → no lane to claim (caller already guarded)
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
      const inflight = await tx
        .select({ id: jobRuns.id })
        .from(jobRuns)
        .where(and(eq(jobRuns.concurrencyKey, key), eq(jobRuns.status, 'running')));
      if (inflight.some((r) => r.id !== run.id)) return false;
      await tx
        .update(jobRuns)
        .set({
          status: 'running',
          claimedAt: new Date(),
          startedAt: new Date(),
          attempts,
          updatedAt: new Date(),
        })
        .where(eq(jobRuns.id, run.id));
      return true;
    });
  }

  // ── ctx.step / ctx.spawnChild (mirror JobWorker) ──────────────────────────

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
      const nextAttempts = (existing?.attempts ?? 0) + 1;
      const seq = nextAttempts; // BullMQ path: seq is per-step attempt index
      await this.stepService.recordStep({
        jobRunId: run.id,
        stepId,
        kind: 'task',
        seq,
        status: 'running',
        startedAt: new Date(),
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
        tenantId: run.tenantId,
      });
    };
  }
}
