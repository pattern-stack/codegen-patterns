/**
 * Sync subsystem — run-recorder protocol (port)
 *
 * `ISyncRunRecorder` is the write side of the audit log. `ExecuteSyncUseCase`
 * (SYNC-5) calls `startRun` at the top of the loop, `recordItem` for each
 * processed change, and `completeRun` in a `finally` block so a run always
 * reaches a terminal status.
 *
 * The Drizzle backend (SYNC-4) persists against `sync_runs` / `sync_run_items`
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
import type { FieldDiff } from './sync-field-diff.protocol';

// ============================================================================
// Lifecycle — inputs
// ============================================================================

/** Args for `startRun`. Mirrors the non-nullable columns on `sync_runs`. */
export interface StartRunInput {
  readonly subscriptionId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly action: 'poll' | 'cdc' | 'webhook' | 'manual' | 'writeback';
  /** Cursor snapshot at run start, or `null` if this is the first run. */
  readonly cursorBefore: unknown | null;
  /**
   * Tenant id when `SYNC_MULTI_TENANT` is enabled. The recorder's own
   * boundary rule (SYNC-6) enforces non-null when the flag is on;
   * orchestrator passes it through from `ExecuteSyncInput.tenantId`.
   */
  readonly tenantId?: string | null;
}

/** Args for `recordItem`. Mirrors the non-nullable columns on `sync_run_items`. */
export interface RecordItemInput {
  readonly syncRunId: string;
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
// ISyncRunRecorder
// ============================================================================

export interface ISyncRunRecorder {
  /** Opens a new `sync_runs` row in `status = 'running'`. Returns the run id. */
  startRun(input: StartRunInput): Promise<{ id: string }>;

  /** Appends one `sync_run_items` row. Throws if `changedFields` is malformed. */
  recordItem(input: RecordItemInput): Promise<void>;

  /**
   * Finalizes the run. Must be called from a `finally` block so an in-flight
   * run never gets stuck in `'running'` state; the orchestrator passes
   * `'failed'` when the iteration body threw.
   */
  completeRun(runId: string, input: CompleteRunInput): Promise<void>;
}
