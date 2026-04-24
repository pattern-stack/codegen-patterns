/**
 * IObservability — read-only composer port for the observability combiner
 * subsystem (ADR-025, OBS-5).
 *
 * Every method:
 *   - Accepts an optional `tenantId`, passed VERBATIM to the owning sibling
 *     port. Observability never re-implements tenant filtering — that is
 *     the owning subsystem's job (jobs / bridge / sync). See
 *     `.claude/skills/observability/SKILL.md` §3.
 *       - `undefined` — "not provided"; sibling default semantics apply.
 *       - `null`      — explicit cross-tenant match (sibling-specific).
 *       - `string`    — filter to that single tenant.
 *   - Returns an empty shape (not throws) when the owning sibling port is
 *     absent in the consumer's DI container. Consumers get a graceful
 *     degradation instead of a boot failure.
 *
 * Phase-1 scope (epic #195): five reads composed from four sibling ports.
 * Cross-subsystem JOIN analytics are deferred to the Cube.js layer
 * (ADR-025 §Phase-1 scope note; skill §5).
 */

import type {
  JobRunFailure,
  PoolStatusCount,
} from '../jobs/job-run-service.protocol';
import type { StatusHistogram } from '../bridge/bridge.protocol';
import type { SyncRunSummary } from '../sync/sync-run-recorder.protocol';
import type { CursorSnapshot } from '../sync/sync-cursor-store.protocol';

export interface IObservability {
  /**
   * Live `(pool, status)` counts across `job_run`. Delegates to
   * `IJobRunService.countByPoolAndStatus`.
   *
   * Empty array when the jobs subsystem is not installed.
   */
  getPoolDepths(tenantId?: string | null): Promise<PoolStatusCount[]>;

  /**
   * Most-recent `failed` job runs, newest first. Delegates to
   * `IJobRunService.listRecentFailed`.
   *
   * Empty array when the jobs subsystem is not installed.
   */
  getRecentFailedJobs(
    limit: number,
    tenantId?: string | null,
  ): Promise<JobRunFailure[]>;

  /**
   * Bridge-delivery status counts over a trailing window. Delegates to
   * `IJobBridge.getStatusHistogram`.
   *
   * Returns an all-zero histogram (`{ pending: 0, delivered: 0, skipped: 0,
   * failed: 0 }`) when the bridge subsystem is not installed — matches the
   * bridge protocol's "fixed keys, zero-filled" contract.
   */
  getBridgeDeliveryHistogram(
    windowHours: number,
    tenantId?: string | null,
  ): Promise<StatusHistogram>;

  /**
   * Recent `sync_runs` (optionally filtered by subscription). Delegates to
   * `ISyncRunRecorder.listRecent`.
   *
   * Empty array when the sync subsystem is not installed.
   */
  getRecentSyncRuns(
    limit: number,
    subscriptionId?: string,
    tenantId?: string | null,
  ): Promise<SyncRunSummary[]>;

  /**
   * Cursor state per enabled `sync_subscriptions` row. Delegates to
   * `ICursorStore.listAll`.
   *
   * Empty array when the sync subsystem is not installed.
   */
  getCursors(tenantId?: string | null): Promise<CursorSnapshot[]>;
}

// Re-export composed return types so consumers of IObservability can import
// them from a single module without reaching into every sibling subsystem.
export type {
  PoolStatusCount,
  JobRunFailure,
  StatusHistogram,
  SyncRunSummary,
  CursorSnapshot,
};
