/**
 * BullMQJobOrchestrator — BullMQ-backed implementation of `IJobOrchestrator`
 * (BULLMQ-1, ADR-022 §58 — the reserved "Phase 6+" backend, now built).
 *
 * Split-of-responsibility (spec §"Postgres + BullMQ coordination"):
 *   - Postgres `job_run` stays the **domain source of truth** — scoping,
 *     hierarchy (`parent_run_id`/`root_run_id`), dedupe/concurrency state,
 *     `listForScope`. All of that is the Drizzle backend's job and is reused
 *     verbatim by extending `DrizzleJobOrchestrator`.
 *   - BullMQ owns the **claim/dispatch** half. `start` adds a job to the
 *     pool's queue (or to a FlowProducer flow when parented); the BullMQ
 *     `Worker` (see `job-worker.bullmq-backend.ts`) consumes it and runs the
 *     handler through the existing `JobHandlerBase` path. `cancel` removes
 *     the queued job; `replay` re-adds it after the shared DB reset.
 *
 * This is **additive**: the Drizzle backend, the core protocol, and app code
 * are untouched. Consumers flip `jobs.backend: bullmq` with no code change —
 * the same `IJobOrchestrator` surface is satisfied.
 *
 * `jobId` (spec §Gotcha 1): BullMQ treats `:` as a Redis key separator and
 * consumers use `vendor:externalId`-shaped idempotency keys, so we derive the
 * `jobId` as `sha1(idempotencyKey)` — colon-safe and stable (same logical key
 * → same id → BullMQ-native dedup). When no dedupe key is configured we fall
 * back to the `job_run.id` (a fresh UUID), which is already colon-safe.
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, eq, inArray, lte } from 'drizzle-orm';
// `bullmq` is an OPTIONAL peer dependency. Only TYPE imports here — types are
// erased at compile time and never resolve `'bullmq'` at runtime, so a
// `drizzle`-only consumer who didn't install bullmq can still load this file
// (it is statically imported by `jobs-domain.module.ts`). The VALUE
// constructors (`Queue`, `FlowProducer`) are loaded lazily via `await
// import('bullmq')` in `loadBullMq()` — mirrors
// the events `event-bus.bullmq-backend.ts` loader. See BULLMQ-1 §Lazy import.
import type { ConnectionOptions, FlowProducer, Queue } from 'bullmq';
import type { DrizzleClient } from '../../types/drizzle';
import type { DrizzleTransaction } from '../events/event-bus.protocol';
import { DRIZZLE } from '../../constants/tokens';
import { jobRuns, jobs, type JobDefinitionRow } from './job-orchestration.schema';
import { DrizzleJobOrchestrator } from './job-orchestrator.drizzle-backend';
import type {
  CancelOptions,
  JobRun,
  StartOptions,
} from './job-orchestrator.protocol';
import { JOBS_MULTI_TENANT } from './jobs-domain.tokens';
import {
  BULLMQ_CONNECTION,
  resolvePoolQueueName,
  type BullMqResolvedConfig,
  BULLMQ_RESOLVED_CONFIG,
} from './bullmq.config';

/**
 * Derive a colon-safe, stable BullMQ `jobId` from a logical idempotency key.
 *
 * SHA-1 over the raw key. Collision analysis (spec §Gotcha 1, resolved during
 * implementation): SHA-1's 160-bit space makes an accidental collision between
 * two *distinct* logical keys astronomically unlikely at any realistic job
 * volume (the birthday bound is ~2^80 keys before a 50% collision chance —
 * orders of magnitude beyond any job throughput). SHA-1's cryptographic
 * weakness is irrelevant here: there is no adversary forging idempotency keys,
 * and even a forged collision only deduplicates two jobs that the caller chose
 * to key identically. We therefore accept SHA-1 with no mitigation. The *same*
 * logical key intentionally maps to the *same* jobId — that is the dedup
 * mechanism, not a collision.
 */
export function sha1JobId(idempotencyKey: string): string {
  return createHash('sha1').update(idempotencyKey).digest('hex');
}

/** BullMQ's lowest priority value (2^21). */
const BULLMQ_MAX_PRIORITY = 2_097_152;
/**
 * Midpoint of BullMQ's [1, 2^21] priority range. `job_run.priority = 0` (the
 * schema default) maps here so elevated runs sort ahead and any de-prioritised
 * caller sorts behind — all within the valid range.
 */
const BULLMQ_PRIORITY_BASE = 1_048_576;

/**
 * Map a `job_run.priority` onto a BullMQ `priority` job opt.
 *
 * The `job_run` contract is "0 = default, HIGHER = claimed first" (Drizzle:
 * `ORDER BY priority DESC`). BullMQ inverts the scale — 1 is the HIGHEST
 * priority and larger numbers are lower — AND, critically, a job with
 * `priority` 0/undefined is NOT "lowest": it goes on the plain FIFO `wait`
 * list, which BullMQ drains AHEAD of the prioritised set. So leaving default
 * jobs unprioritised (the original bug) demoted every *elevated* run behind
 * every *default* run — the exact opposite of the contract. The fix: give
 * EVERY run an explicit priority. Higher `job_run.priority` → numerically lower
 * BullMQ priority; the default (0) lands at the midpoint. Relative ordering
 * then matches Drizzle's `DESC` for the whole cohort.
 */
export function bullmqPriorityFor(runPriority: number): number {
  const p = Number.isFinite(runPriority) ? runPriority : 0;
  return Math.max(1, Math.min(BULLMQ_MAX_PRIORITY, BULLMQ_PRIORITY_BASE - p));
}

// Constructor types for the lazily-loaded `bullmq` value exports. Typed via
// `typeof` the type-only imports so the cached ctors stay strongly typed
// without a runtime `import`.
type QueueCtor = typeof import('bullmq').Queue;
type FlowProducerCtor = typeof import('bullmq').FlowProducer;

@Injectable()
export class BullMQJobOrchestrator extends DrizzleJobOrchestrator {
  // TODO(logging-subsystem): swap to ILogger once ADR-028 lands
  private readonly bullLogger = new Logger(BullMQJobOrchestrator.name);

  /** Lazily-opened `Queue` handles, one per pool. */
  private readonly queues = new Map<string, Queue>();
  /** Single FlowProducer for parent/child hierarchies. Lazily opened. */
  private _flow: FlowProducer | null = null;

  /**
   * Cached `bullmq` value constructors, populated by `loadBullMq()` on first
   * use (the `start`/`cancel`/`replay` entrypoints `await` it before touching
   * a queue). Kept off the import graph so a `drizzle`-only consumer never
   * resolves the optional `'bullmq'` package.
   */
  private QueueCtor: QueueCtor | null = null;
  private FlowProducerCtor: FlowProducerCtor | null = null;
  private bullMqLoad: Promise<void> | null = null;

  /**
   * Own reference to the Drizzle client. `DrizzleJobOrchestrator.db` is
   * `private` (can't be redeclared even privately in a subclass), and the
   * spec forbids touching that file — so the subclass keeps its own handle
   * under a distinct name (same instance, passed through to `super`) for the
   * cancel-cascade snapshot + definition/run loads below.
   */
  private readonly bullDb: DrizzleClient;

  constructor(
    @Inject(DRIZZLE) db: DrizzleClient,
    @Inject(JOBS_MULTI_TENANT) multiTenant: boolean,
    @Inject(BULLMQ_CONNECTION) private readonly connection: ConnectionOptions,
    @Optional()
    @Inject(BULLMQ_RESOLVED_CONFIG)
    private readonly bullConfig: BullMqResolvedConfig | null = null,
  ) {
    super(db, multiTenant);
    this.bullDb = db;
  }

  /**
   * Lazily load the optional `bullmq` package and cache its value
   * constructors. Idempotent (single in-flight promise). Throws a friendly,
   * actionable error when the consumer selected `backend: 'bullmq'` but did
   * not install the package — mirrors `createRedisClient` in the redis event
   * backend. Must be `await`ed before any `queueFor`/`flow` access.
   */
  private async loadBullMq(): Promise<void> {
    if (this.QueueCtor && this.FlowProducerCtor) return;
    if (!this.bullMqLoad) {
      this.bullMqLoad = (async () => {
        try {
          const mod = await import('bullmq');
          this.QueueCtor = mod.Queue;
          this.FlowProducerCtor = mod.FlowProducer;
        } catch {
          throw new Error(
            'BullMQ backend requires the "bullmq" package. Install it with: npm install bullmq',
          );
        }
      })();
    }
    await this.bullMqLoad;
  }

  /**
   * Open (or reuse) the `Queue` for a pool. Synchronous — callers `await
   * loadBullMq()` first so `QueueCtor` is populated.
   */
  private queueFor(pool: string): Queue {
    if (!this.QueueCtor) {
      throw new Error('BullMQJobOrchestrator: queueFor called before loadBullMq()');
    }
    const name = resolvePoolQueueName(pool, this.bullConfig);
    let q = this.queues.get(name);
    if (!q) {
      // Bounded retention so completed/failed job keys are reaped — otherwise
      // Redis grows unbounded (the bridge relay re-adds ~1 wrapper job/s). Safe
      // for relay idempotency: reconcilePending gates on Postgres
      // `status='pending'`, not the retained Redis key (the
      // dealbrain-bullmq-audit DEFAULT_JOB_OPTIONS pattern).
      q = new this.QueueCtor(name, {
        connection: this.connection,
        defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 },
      });
      this.queues.set(name, q);
    }
    return q;
  }

  private flow(): FlowProducer {
    if (!this.FlowProducerCtor) {
      throw new Error('BullMQJobOrchestrator: flow called before loadBullMq()');
    }
    if (!this._flow) {
      this._flow = new this.FlowProducerCtor({ connection: this.connection });
    }
    return this._flow;
  }

  // ==========================================================================
  // start — Postgres insert (super) + BullMQ dispatch
  // ==========================================================================

  override async start(
    type: string,
    input: unknown,
    opts: StartOptions = {},
    tx?: DrizzleTransaction,
  ): Promise<JobRun> {
    // (1) Postgres remains source of truth — the Drizzle backend handles the
    //     job-definition lookup, dedupe short-circuit, concurrency collision,
    //     parent/root resolution, and the `job_run` INSERT. If dedupe
    //     short-circuited it returns the incumbent row whose dispatch already
    //     happened on the original start; we must not enqueue again.
    const run = await super.start(type, input, opts, tx);

    // Dedupe returned an existing run (its createdAt predates this call) —
    // BullMQ-native dedup already covered the dispatch. Skip re-enqueue.
    // We detect this by checking the run was freshly created in THIS call:
    // a brand-new run has status 'pending' and zero attempts AND its id is
    // not yet known to BullMQ. The cheapest reliable signal is the dedupe
    // path's contract: super.start returns the incumbent unchanged. Since we
    // cannot distinguish purely from the row, we rely on `jobId` idempotency
    // — re-adding with the same jobId is a no-op in BullMQ, so the enqueue is
    // safe to attempt unconditionally.

    await this.dispatch(run, type);
    return run;
  }

  /**
   * Map a `job_run` row onto a BullMQ job via `queue.add`. When the run has a
   * `parentRunId` we attach it to the parent's existing BullMQ job through the
   * `parent: { id, queue }` opt — BullMQ then tracks the parent/child link in
   * its own graph. (The FlowProducer is reserved for whole-tree atomic
   * submits, exposed as an opt-in extension via `flowProducer()`; runtime
   * `ctx.spawnChild` is incremental, so `queue.add` with a parent ref is the
   * correct primitive here.)
   *
   * The `jobId` is colon-safe + stable: `sha1(dedupeKey)` when a dedupe key is
   * present (so the same logical key dedups), else the `job_run.id` UUID
   * (already colon-free).
   *
   * The domain `parentClosePolicy` cascade is still enforced in Postgres by
   * the shared `cancel` path — BullMQ's parent link is dispatch bookkeeping,
   * not the authority.
   */
  private async dispatch(run: JobRun, type: string): Promise<void> {
    await this.loadBullMq();
    const def = await this.loadDefinition(type);
    const jobId = run.dedupeKey ? sha1JobId(run.dedupeKey) : run.id;

    const jobOpts: Record<string, unknown> = {
      jobId,
      ...this.retryOpts(def),
      ...this.dedupeOpts(run, def),
      ...this.scheduleOpts(run),
    };

    if (run.parentRunId) {
      const parentRow = await this.loadRun(run.parentRunId);
      if (parentRow) {
        const parentJobId = parentRow.dedupeKey
          ? sha1JobId(parentRow.dedupeKey)
          : parentRow.id;
        jobOpts.parent = {
          id: parentJobId,
          queue: resolvePoolQueueName(parentRow.pool, this.bullConfig),
        };
      }
    }

    // The processor reads the authoritative input from `job_run`; the payload
    // carries the runId so it can load the row, plus type/input for logging.
    const payload = { runId: run.id, type, input: run.input };
    await this.queueFor(run.pool).add(type, payload, jobOpts);
  }

  /**
   * Opt-in extension (spec §Extensions): expose the FlowProducer for
   * consumers that want to submit a whole parent/child DAG atomically up
   * front, rather than incrementally via `ctx.spawnChild`. Backend-specific —
   * code using it is not portable to the Drizzle backend. Async because it
   * lazily loads the optional `bullmq` package on first use.
   */
  async flowProducer(): Promise<FlowProducer> {
    await this.loadBullMq();
    return this.flow();
  }

  private retryOpts(def: JobDefinitionRow): {
    attempts?: number;
    backoff?: { type: 'fixed' | 'exponential'; delay: number };
  } {
    const policy = def.retryPolicy;
    if (!policy) return {};
    return {
      attempts: policy.attempts,
      backoff: {
        type: policy.backoff === 'exponential' ? 'exponential' : 'fixed',
        delay: policy.baseMs,
      },
    };
  }

  private dedupeOpts(
    run: JobRun,
    def: JobDefinitionRow,
  ): { deduplication?: { id: string; ttl?: number } } {
    if (!run.dedupeKey || !def.dedupeWindowMs) return {};
    return {
      deduplication: {
        id: sha1JobId(run.dedupeKey),
        ttl: def.dedupeWindowMs,
      },
    };
  }

  /**
   * Map the core `StartOptions` scheduling/ordering fields onto BullMQ job
   * opts so the BullMQ backend honours them identically to the Drizzle worker
   * (ADR-041 — these are core-contract fields, NOT extensions; the backend
   * previously dropped both, silently degrading future-dated/prioritised
   * starts to immediate-FIFO dispatch):
   *
   *   - `runAt` (future) → `delay` ms. The Drizzle claim query gates on
   *     `run_at <= now()` (idx_job_run_claim); BullMQ instead delays the job
   *     until the boundary elapses. `run_at` is `NOT NULL DEFAULT now()`, so a
   *     past/now value (the default) produces a non-positive delta and sets no
   *     `delay` — the common path stays a plain enqueue.
   *   - `priority` → BullMQ `priority`, for EVERY run (see `bullmqPriorityFor`
   *     — leaving default-priority jobs unprioritised inverts the contract,
   *     because BullMQ drains the unprioritised FIFO list ahead of the
   *     prioritised set).
   */
  private scheduleOpts(run: JobRun): { delay?: number; priority: number } {
    const out: { delay?: number; priority: number } = {
      priority: bullmqPriorityFor(typeof run.priority === 'number' ? run.priority : 0),
    };
    if (run.runAt) {
      const delay = run.runAt.getTime() - Date.now();
      if (delay > 0) out.delay = delay;
    }
    return out;
  }

  // ==========================================================================
  // cancel — Postgres cascade (super) + remove from queue
  // ==========================================================================

  override async cancel(runId: string, opts: CancelOptions = {}): Promise<void> {
    // Snapshot the subtree BEFORE the DB cascade flips rows to canceled, so we
    // can remove every affected BullMQ job. We read the target's rootRunId and
    // the non-terminal descendants the same way the Drizzle cascade does.
    const target = await this.loadRun(runId);

    await super.cancel(runId, opts);

    if (!target) return;
    await this.loadBullMq();
    // Remove the target's own queued job.
    await this.removeFromQueue(target);

    if (opts.cascade === false) return;

    // Remove descendants' queued jobs (the DB rows were just canceled by
    // super.cancel; we mirror that into BullMQ so workers don't pick them up).
    const descendants = await this.bullDb
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.rootRunId, target.rootRunId));
    for (const child of descendants) {
      if (child.id === runId) continue;
      await this.removeFromQueue(child as JobRun);
    }
  }

  private async removeFromQueue(run: JobRun): Promise<void> {
    const jobId = run.dedupeKey ? sha1JobId(run.dedupeKey) : run.id;
    try {
      const job = await this.queueFor(run.pool).getJob(jobId);
      if (job) await job.remove();
    } catch (err) {
      // A job already moved to active/completed cannot always be removed;
      // the Postgres cancel is authoritative either way.
      this.bullLogger.warn(
        `cancel: could not remove BullMQ job ${jobId} (pool=${run.pool}): ${(err as Error).message}`,
      );
    }
  }

  // ==========================================================================
  // replay — Postgres reset (super) + re-enqueue
  // ==========================================================================

  override async replay(runId: string): Promise<JobRun> {
    const run = await super.replay(runId);
    await this.dispatch(run, run.jobType);
    return run;
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private async loadDefinition(type: string): Promise<JobDefinitionRow> {
    const [def] = await this.bullDb
      .select()
      .from(jobs)
      .where(eq(jobs.type, type))
      .limit(1);
    if (!def) {
      throw new Error(`BullMQJobOrchestrator: no job definition for '${type}'`);
    }
    return def as JobDefinitionRow;
  }

  private async loadRun(id: string): Promise<JobRun | null> {
    const [row] = await this.bullDb
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.id, id))
      .limit(1);
    return (row as JobRun) ?? null;
  }

  /**
   * BRIDGE-1 — reserved-pool enqueue relay. The event→job bridge inserts
   * wrapper `job_run` rows DIRECTLY (raw insert in `BridgeOutboxDrainHook`, for
   * FK + dedup correctness) rather than via `start()`, so they are never
   * dispatched to BullMQ by the normal start→dispatch path. Under the Drizzle
   * backend a polling worker claims them; under BullMQ there is no poll. This
   * relay closes the seam: re-dispatch every pending run in the given (reserved)
   * pools. `dispatch` is idempotent — the wrapper's `jobId` is its `run.id`
   * (colon-free UUID), so a re-add for an already-queued/in-flight job is a
   * BullMQ no-op; a run that has been claimed is no longer `pending` and is
   * skipped. Safe to run on a short interval as the bridge's wake, and
   * self-healing: a wrapper whose enqueue was lost (Redis hiccup) is
   * re-dispatched on the next tick. (This is the outbox-relay half of the
   * transactional-outbox pattern — the wrapper rows are an outbox that BullMQ
   * needs relayed, exactly like the events drain relays domain_events.)
   *
   * Scoped to RESERVED pools only: regular runs are dispatched promptly by
   * `start()`, and reserved `events_*` pools carry only framework bridge
   * wrappers, so there is no race with a freshly-started regular run.
   */
  async reconcilePending(pools: string[]): Promise<void> {
    if (pools.length === 0) return;
    await this.loadBullMq();
    const rows = await this.bullDb
      .select()
      .from(jobRuns)
      .where(
        and(
          eq(jobRuns.status, 'pending'),
          inArray(jobRuns.pool, pools),
          lte(jobRuns.runAt, new Date()),
        ),
      );
    for (const row of rows) {
      const run = row as JobRun;
      try {
        await this.dispatch(run, run.jobType);
      } catch (err) {
        this.bullLogger.warn(
          `reconcilePending: dispatch of run ${run.id} (pool=${run.pool}) ` +
            `failed: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Close all open queue + flow connections. Called on module destroy. */
  async closeConnections(): Promise<void> {
    for (const q of this.queues.values()) {
      await q.close().catch(() => undefined);
    }
    this.queues.clear();
    if (this._flow) {
      await this._flow.close().catch(() => undefined);
      this._flow = null;
    }
  }
}
