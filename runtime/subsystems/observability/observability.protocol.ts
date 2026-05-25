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
  JobRunPage,
  JobRunSummary,
  ListJobRunsQuery,
  PoolStatusCount,
} from '../jobs/job-run-service.protocol';
import type {
  EventPage,
  EventSummary,
  ListEventsQuery,
} from '../events/event-read.protocol';
import type { StatusHistogram } from '../bridge/bridge.protocol';
import type { SyncRunSummary } from '../sync/sync-run-recorder.protocol';
import type { CursorSnapshot } from '../sync/sync-cursor-store.protocol';

/**
 * One chronological entry in a correlation timeline (OBS-LIST-1). Either a
 * `job_run` or a `domain_event` sharing the same `rootRunId`, tagged with a
 * `kind` discriminator and a single `at` timestamp used for ordering.
 */
export type CorrelationTimelineEntry =
  | { kind: 'job_run'; at: Date; run: JobRunSummary }
  | { kind: 'event'; at: Date; event: EventSummary };

/**
 * Stitched view of everything correlated to a single `rootRunId`
 * (OBS-LIST-1): the job runs sharing that root plus the domain events whose
 * `metadata.rootRunId` matches, merged into one ascending timeline with a
 * small roll-up summary.
 */
export interface CorrelationTimeline {
  rootRunId: string;
  /** Ascending by `at`. Job runs ordered by `createdAt`; events by `occurredAt`. */
  entries: CorrelationTimelineEntry[];
  summary: {
    runCount: number;
    eventCount: number;
    /** Earliest `at` across all entries, or `null` when empty. */
    startedAt: Date | null;
    /** Latest `at` across all entries, or `null` when empty. */
    lastActivityAt: Date | null;
  };
}

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

  /**
   * Paginated, filterable `job_run` list (OBS-LIST-1). Delegates to
   * `IJobRunService.listJobRuns`. Keyset pagination on `created_at`.
   *
   * Returns an empty page (`{ items: [], nextCursor: null }`) when the jobs
   * subsystem is not installed.
   */
  listJobRuns(query?: ListJobRunsQuery): Promise<JobRunPage>;

  /**
   * Paginated, filterable `domain_events` list (OBS-LIST-1). Delegates to
   * `IEventReadPort.listEvents`. Keyset pagination on `occurred_at`.
   *
   * Returns an empty page when the events read port is not installed (e.g.
   * the events subsystem is absent, or its backend is `redis` which retains
   * no history).
   */
  listEvents(query?: ListEventsQuery): Promise<EventPage>;

  /**
   * Stitch the job runs and domain events sharing a `rootRunId` into a
   * single ascending timeline + summary (OBS-LIST-1). Composes
   * `IJobRunService.listJobRuns` (filtered by the run tree) and
   * `IEventReadPort.listEvents({ rootRunId })`.
   *
   * Returns an empty timeline (zero counts, null bounds) when neither the
   * jobs subsystem nor the events read port is installed.
   */
  getCorrelationTimeline(
    rootRunId: string,
    tenantId?: string | null,
  ): Promise<CorrelationTimeline>;
}

// Re-export composed return types so consumers of IObservability can import
// them from a single module without reaching into every sibling subsystem.
export type {
  PoolStatusCount,
  JobRunFailure,
  JobRunSummary,
  JobRunPage,
  ListJobRunsQuery,
  EventSummary,
  EventPage,
  ListEventsQuery,
  StatusHistogram,
  SyncRunSummary,
  CursorSnapshot,
};
