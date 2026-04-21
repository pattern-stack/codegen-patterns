/**
 * Typed errors for the job orchestration domain (ADR-022, JOB-3).
 *
 * All thrown by the Drizzle orchestrator (and mirrored by the Memory
 * backend in JOB-4). They exist as classes so consumers can `instanceof`
 * them in catch blocks and exception filters can map them to HTTP codes.
 */
import type { JobRun } from './job-orchestrator.protocol';

/**
 * `start(type, …)` was called for a job type that has no row in the `job`
 * table. At runtime this usually means the handler was not decorated or the
 * boot validator (JOB-5) has not registered it yet.
 */
export class JobTypeNotFoundError extends Error {
  override readonly name = 'JobTypeNotFoundError';
  constructor(public readonly jobType: string) {
    super(`No job definition registered for type '${jobType}'.`);
  }
}

/**
 * Thrown by `start` when `collision_mode === 'reject'` and a non-terminal
 * run with the same `concurrency_key` already exists. Carries the incumbent
 * so callers can surface its id or subscribe to its completion event.
 */
export class JobCollisionError extends Error {
  override readonly name = 'JobCollisionError';
  constructor(
    public readonly jobType: string,
    public readonly concurrencyKey: string,
    public readonly incumbent: JobRun,
  ) {
    super(
      `Job type '${jobType}' has an in-flight run with concurrency_key ` +
        `'${concurrencyKey}' (incumbent ${incumbent.id}); collision_mode=reject.`,
    );
  }
}

/**
 * `replay` was called on a run that is not in a replayable terminal state
 * (i.e. still `pending` / `running` / `waiting`). Replay always spawns
 * fresh execution and therefore requires the source run to be settled.
 */
export class JobNotReplayableError extends Error {
  override readonly name = 'JobNotReplayableError';
  constructor(
    public readonly runId: string,
    public readonly currentStatus: string,
  ) {
    super(
      `Run ${runId} is not replayable from status '${currentStatus}'. ` +
        `Only 'completed', 'failed', 'timed_out', and 'canceled' are eligible.`,
    );
  }
}

/**
 * A `concurrency_key_template` or `dedupe_key_template` referenced a field
 * that is not present on the input payload. Caught at `start` time so the
 * caller sees the misconfiguration synchronously rather than at claim time.
 */
export class JobTemplateFieldMissingError extends Error {
  override readonly name = 'JobTemplateFieldMissingError';
  constructor(
    public readonly template: string,
    public readonly field: string,
  ) {
    super(
      `Template '${template}' references input field '${field}' which is ` +
        `missing or undefined on the payload.`,
    );
  }
}

/**
 * Thrown by the four multi-tenant-aware service-layer backends (JOB-8)
 * when `JobsDomainModule` was configured with `multiTenant: true` but the
 * caller did not pass a `tenantId` in the relevant options object.
 *
 * **Strict enforcement rationale (resolved 2026-04-18).** Cross-tenant data
 * leakage is the worst class of bug a multi-tenant system can ship; surfacing
 * the misuse loudly at the call site (rather than silently defaulting to
 * `null` or to the "last tenant seen") prevents both accidental global
 * writes and sneaky reads that return a union of tenants.
 *
 * - `undefined` `tenantId` → throw this error.
 * - Explicit `null` `tenantId` → passes; opts the call into cross-tenant
 *   background work (e.g. a nightly housekeeping job that must scan all
 *   tenants). The row is persisted with `tenant_id = NULL`.
 */
export class MissingTenantIdError extends Error {
  override readonly name = 'MissingTenantIdError';
  constructor(public readonly method: string) {
    super(
      `MissingTenantIdError: JobsDomainModule was configured with ` +
        `multiTenant=true but ${method} was called without tenantId ` +
        `(undefined). Pass an explicit tenantId, or pass null for ` +
        `cross-tenant work.`,
    );
  }
}

/**
 * Thrown by `JobWorkerModule.onModuleInit` (Drizzle backend only) when the
 * `job` table contains type rows for which no `@JobHandler` is registered
 * in the running process. Surfaces every orphaned type at once so a single
 * boot tells the operator everything to clean up.
 *
 * Skipped entirely in memory mode (Q4 resolution 2026-04-19) — the memory
 * backend has no DB rows to validate; `MemoryJobOrchestrator.start()`
 * throws `JobTypeNotFoundError` synchronously for unknown types instead.
 */
export class BootValidationError extends Error {
  override readonly name = 'BootValidationError';
  constructor(public readonly missingHandlers: string[]) {
    super(
      `BootValidationError: ${missingHandlers.length} orphaned job type(s) ` +
        `in 'job' table with no matching @JobHandler in the running process: ` +
        `[${missingHandlers.join(', ')}]. Either register the handler(s) or ` +
        `remove the rows.`,
    );
  }
}

/**
 * Thrown by `JobWorkerModule.onModuleInit` when one or more `@JobHandler`
 * classes target a `reserved: true` pool from the resolved pool config
 * (the three `events_*` pools are reserved for the events subsystem
 * outbox drain). Listing every offender on a single boot avoids the
 * fix-one-restart-fix-next loop.
 */
export class ReservedPoolViolationError extends Error {
  override readonly name = 'ReservedPoolViolationError';
  constructor(
    public readonly offenders: ReadonlyArray<{
      handlerClass: string;
      pool: string;
    }>,
  ) {
    super(
      `ReservedPoolViolationError: ${offenders.length} @JobHandler(s) target ` +
        `reserved pools — reserved pools are framework-only:\n` +
        offenders
          .map((o) => `  - ${o.handlerClass} → pool='${o.pool}'`)
          .join('\n'),
    );
  }
}
