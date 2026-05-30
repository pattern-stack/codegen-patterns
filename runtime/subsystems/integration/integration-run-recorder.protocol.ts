/**
 * Integration subsystem — run-recorder protocol (port)
 *
 * `IIntegrationRunRecorder` is the write side of the audit log. `ExecuteIntegrationUseCase`
 * (SYNC-5) calls `startRun` at the top of the loop, `recordItem` for each
 * processed change, and `completeRun` in a `finally` block so a run always
 * reaches a terminal status.
 *
 * The Drizzle backend (SYNC-4) persists against `integration_runs` / `integration_run_items`
 * from the SYNC-1 schema. Tests use lightweight in-memory fakes — no
 * dedicated memory backend ships; the surface is small enough that inline
 * fakes keep the intent local to each spec.
 *
 * `changed_fields` on `recordItem` is validated by the implementation via
 * `FieldDiffSchema.parse` (ADR-0003 contract). Orchestrator callers pass the
 * `DiffResult` the differ returned — `'noop'` is translated to `{}` by the
 * orchestrator before reaching the recorder, so the recorder's input is
 * always a `FieldDiff`.
 */
import type { FieldDiff } from './integration-field-diff.protocol';

// ============================================================================
// Lifecycle — inputs
// ============================================================================

/** Args for `startRun`. Mirrors the non-nullable columns on `integration_runs`. */
export interface StartRunInput {
  readonly subscriptionId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly action: 'poll' | 'cdc' | 'webhook' | 'manual' | 'writeback';
  /** Cursor snapshot at run start, or `null` if this is the first run. */
  readonly cursorBefore: unknown | null;
  /**
   * Tenant id when `INTEGRATION_MULTI_TENANT` is enabled. The recorder's own
   * boundary rule (SYNC-6) enforces non-null when the flag is on;
   * orchestrator passes it through from `ExecuteIntegrationInput.tenantId`.
   */
  readonly tenantId?: string | null;
}

/** Args for `recordItem`. Mirrors the non-nullable columns on `integration_run_items`. */
export interface RecordItemInput {
  readonly integrationRunId: string;
  readonly entityType: string;
  readonly externalId: string;
  readonly localId?: string | null;
  readonly operation: 'created' | 'updated' | 'deleted' | 'noop';
  readonly status: 'success' | 'failed' | 'skipped';
  /**
   * Structured per-field diff — ADR-0003. `{}` for noop / skipped items.
   * The recorder validates this against `FieldDiffSchema` on every write.
   */
  readonly changedFields: FieldDiff;
  readonly title?: string | null;
  readonly error?: string | null;
  readonly tenantId?: string | null;
}

/** Args for `completeRun`. */
export interface CompleteRunInput {
  readonly status: 'success' | 'no_changes' | 'failed';
  readonly recordsFound: number;
  readonly recordsProcessed: number;
  readonly cursorAfter: unknown | null;
  readonly durationMs: number;
  readonly error?: string | null;
}

// ============================================================================
// Read projection — `listRecent`
// ============================================================================

/**
 * Denormalized view of one `integration_runs` row, JOINed against
 * `integration_subscriptions` to surface `integrationId` in a single read. Consumed
 * by the OBS-5 observability composer (epic #195).
 *
 * `recordsProcessed` is the denormalized column on `integration_runs` — it does NOT
 * count `integration_run_items` rows. A correlated subquery per run would be
 * required for a true item count; deferred as a follow-up if needed.
 *
 * Memory backends can't know `integrationId` without subscription metadata
 * — see each memory backend for the seedable `subscriptions` side-map that
 * tests populate. When metadata is missing, memory backends emit an empty
 * string so the shape stays stable (documented in the memory backend).
 */
export interface IntegrationRunSummary {
  readonly id: string;
  readonly subscriptionId: string;
  /** Resolved by Drizzle via JOIN; empty string from memory if not seeded. */
  readonly integrationId: string;
  readonly status: 'running' | 'success' | 'no_changes' | 'failed';
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly recordsProcessed: number;
  readonly tenantId: string | null;
}

// ============================================================================
// IIntegrationRunRecorder
// ============================================================================

export interface IIntegrationRunRecorder {
  /** Opens a new `integration_runs` row in `status = 'running'`. Returns the run id. */
  startRun(input: StartRunInput): Promise<{ id: string }>;

  /** Appends one `integration_run_items` row. Throws if `changedFields` is malformed. */
  recordItem(input: RecordItemInput): Promise<void>;

  /**
   * Finalizes the run. Must be called from a `finally` block so an in-flight
   * run never gets stuck in `'running'` state; the orchestrator passes
   * `'failed'` when the iteration body threw.
   */
  completeRun(runId: string, input: CompleteRunInput): Promise<void>;

  /**
   * Recent `integration_runs` rows ordered by `started_at DESC`, capped at `limit`.
   *
   * Filter is `subscriptionId` — the natural FK on `integration_runs`. An
   * integration-wide view requires filtering on `integration_subscriptions.integration_id`
   * through the JOIN and is deferred as a follow-up (epic #195 OBS-4 spec).
   *
   * @param limit           hard cap on rows returned (no implicit default)
   * @param subscriptionId  optional FK filter; omit for cross-subscription view
   * @param tenantId        required by Drizzle backend when
   *                        `INTEGRATION_MULTI_TENANT` is on (throws
   *                        `MissingTenantIdError` otherwise); memory backend
   *                        accepts but ignores
   */
  listRecent(
    limit: number,
    subscriptionId?: string,
    tenantId?: string | null,
  ): Promise<IntegrationRunSummary[]>;
}
