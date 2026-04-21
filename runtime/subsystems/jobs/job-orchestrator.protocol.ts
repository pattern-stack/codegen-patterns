/**
 * IJobOrchestrator — the primary port for the job orchestration domain
 * (ADR-022, JOB-2).
 *
 * Consumers (use cases, event subscribers) inject this via
 * `@Inject(JOB_ORCHESTRATOR)` and call `start` / `cancel` / `replay`.
 * Concrete backends (JOB-3 Drizzle, JOB-4 Memory) satisfy this contract.
 *
 * Single-layer architecture reminder: there is no `IJobQueue` executor port.
 * The orchestrator writes `job_run` rows directly; the `JobWorker` of JOB-3
 * polls `job_run` via `SELECT ... FOR UPDATE SKIP LOCKED`.
 */
import type { JobRunRow } from './job-orchestration.schema';
import type { JobHandlerMeta, ParentClosePolicy } from './job-handler.base';

/**
 * Public return type for orchestrator reads. Re-exported as `JobRun` so
 * protocols and consumer code don't import the raw Drizzle row name.
 */
export type JobRun = JobRunRow;

export interface StartOptions {
  /**
   * Optional scope attachment. `listForScope` queries use this pair; the
   * column is free-text (no CHECK constraint) — type safety for `entityType`
   * lives at the TS layer via JOB-7's generated `ScopeEntityType` union.
   */
  scope?: { entityType: string; entityId: string };

  /** Overrides the pool declared in `@JobHandler({ pool })` metadata. */
  pool?: string;

  /** Schedule the run. When omitted, run as soon as the worker claims it. */
  runAt?: Date;

  /** 0 = default; higher values claimed first by `ORDER BY priority DESC`. */
  priority?: number;

  /** Free-form routing/audit tags. Persisted on `job_run.tags`. */
  tags?: Record<string, string>;

  /** Must align with `triggerSourceEnum` values landed in JOB-1. */
  triggerSource?: 'manual' | 'schedule' | 'event' | 'parent';

  /** Optional reference to the triggering event, schedule, etc. */
  triggerRef?: string;

  /**
   * What happens to this run's children if this run reaches a terminal
   * state. Stored on the child at spawn time; see `ParentClosePolicy`.
   */
  parentClosePolicy?: ParentClosePolicy;

  /** Internal — set by `ctx.spawnChild`. User code should not pass this. */
  parentRunId?: string;

  /**
   * Multi-tenancy opt-in (JOB-8). When `JobsDomainModule` is configured
   * with `multiTenant: true`, this field is required:
   *   - `string` — tenant the run belongs to (written to `job_run.tenant_id`).
   *   - `null`   — cross-tenant background work; row persisted with NULL.
   *   - `undefined` — throws `MissingTenantIdError` at the backend.
   * When `multiTenant: false`, the field is ignored and the column is
   * always written as `NULL`.
   */
  tenantId?: string | null;
}

export interface CancelOptions {
  /**
   * Conceptually defaults to `true` for root cancellation — cascading via
   * `root_run_id` is the expected behaviour when an operator cancels a
   * run. Backends in JOB-3/JOB-4 implement the default; callers passing
   * `false` opt into "cancel only this node, leave descendants".
   */
  cascade?: boolean;
  reason?: string;

  /**
   * Multi-tenancy gate (JOB-8). When `multiTenant: true`, the backend
   * additionally filters `WHERE tenant_id = :tenantId` — cancelling a run
   * that belongs to a different tenant is a **no-op** (not an error), so
   * cross-tenant cancellation attempts are silent rather than leaking
   * existence information. `undefined` throws `MissingTenantIdError`;
   * explicit `null` matches `tenant_id IS NULL` rows.
   */
  tenantId?: string | null;
}

/**
 * Boot-time upsert payload — one entry per registered `@JobHandler` class.
 * Constructed by `JobWorkerModule.onModuleInit` from `HandlerRegistry.getAll()`
 * and handed to the orchestrator so each backend can persist `job` definitions
 * in whatever way it stores them (Drizzle: `ON CONFLICT (type) DO UPDATE`
 * gated by metadata content; memory: populate `MemoryJobStore.jobs`).
 */
export interface JobUpsertEntry {
  type: string;
  meta: JobHandlerMeta<unknown>;
  /**
   * Handler class constructor — the memory backend keeps a reference for
   * `tick()` execution. Drizzle backend ignores this (worker resolves the
   * class via `JOB_HANDLER_REGISTRY` at claim time).
   */
  handlerClass: new (...args: unknown[]) => unknown;
}

/**
 * Pool definition surface as the orchestrator needs it for boot-time row
 * materialisation. Defined locally here (not imported from
 * `pool-config.loader.ts`) so the protocol layer keeps zero dependencies on
 * runtime config wiring — the loader's `PoolDefinition` is structurally
 * compatible.
 */
export interface JobPoolDef {
  queue: string;
  concurrency: number;
  reserved: boolean;
  description?: string;
}

export interface IJobOrchestrator {
  /**
   * Create a `pending` `job_run` row and return it. Does NOT block waiting
   * for the worker to pick the run up; consumers that need completion
   * semantics should subscribe to the emitted completion event.
   */
  start(type: string, input: unknown, opts?: StartOptions): Promise<JobRun>;

  /**
   * Cancel a run (and, by default, its entire root-run subtree). Idempotent
   * — cancelling an already-terminal run is a no-op.
   */
  cancel(runId: string, opts?: CancelOptions): Promise<void>;

  /**
   * Re-run from the policy declared in `@JobHandler({ replayFrom })`.
   * Returns the new `job_run` row (replay always spawns a fresh row —
   * the original is preserved for audit).
   */
  replay(runId: string): Promise<JobRun>;

  /**
   * Boot-time materialisation of `job` definitions from `@JobHandler`
   * metadata. Called once per process by `JobWorkerModule.onModuleInit`.
   *
   * Drizzle backend: hash-gated `INSERT … ON CONFLICT (type) DO UPDATE …
   * WHERE` (Q3 resolution 2026-04-19). The `UPDATE` branch executes only
   * when one of the persisted metadata fields differs from the incoming
   * payload; `version` bumps only on a real change; concurrent boots with
   * identical content are idempotent no-ops.
   *
   * Memory backend: populates `MemoryJobStore.jobs` and the in-process
   * handler-class registry consumed by `MemoryJobOrchestrator.tick`.
   *
   * Returns the orphaned types — types present in DB but absent from
   * `entries`. The caller (boot validator) decides whether to throw or
   * warn. Memory backend always returns `[]` (Q4 resolution 2026-04-19 —
   * validator skipped in memory mode).
   */
  upsertJobRows(
    entries: JobUpsertEntry[],
    poolConfig: ReadonlyMap<string, JobPoolDef>,
  ): Promise<{ orphaned: string[] }>;
}
