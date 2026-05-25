/**
 * IJobRunService — scope-oriented queries and bulk operations over
 * `job_run` rows (ADR-022, JOB-2).
 *
 * This is a separate port from `IJobOrchestrator` because the access
 * pattern is different: orchestrator mutates individual runs by id;
 * run service scans by `(scope_entity_type, scope_entity_id)`.
 */
import type { JobRun } from './job-orchestrator.protocol';

export interface ListForScopeOptions {
  /**
   * Single status or set. Widens to the full `JobRun['status']` union so
   * callers can pass values straight from `jobRunStatusEnum`.
   */
  status?: JobRun['status'] | JobRun['status'][];
  jobType?: string;
  limit?: number;
  offset?: number;
  orderBy?:
    | 'created_at desc'
    | 'created_at asc'
    | 'run_at desc'
    | 'run_at asc';

  /**
   * Multi-tenancy gate (JOB-8). When `multiTenant: true`, the backend adds
   * `AND tenant_id = :tenantId` to the scope query. `undefined` throws
   * `MissingTenantIdError`; explicit `null` matches `tenant_id IS NULL`
   * rows (cross-tenant background work).
   */
  tenantId?: string | null;
}

/**
 * JOB-8 — scoped bulk ops take the same tenant gate as `listForScope`.
 * Added in JOB-8; pre-JOB-8 callers passing nothing continue to compile.
 */
export interface CancelForScopeOptions {
  tenantId?: string | null;
}

export interface RescheduleForScopeOptions {
  tenantId?: string | null;
}

/**
 * One row per `(pool, status)` combination currently present in `job_run`.
 * Used by observability to render pool-depth dashboards (OBS-2).
 */
export interface PoolStatusCount {
  pool: string;
  status: JobRun['status'];
  count: number;
}

/**
 * Filter + keyset-pagination input for `IJobRunService.listJobRuns`
 * (OBS-LIST-1). The combiner's `listJobRuns` forwards this verbatim.
 *
 * Pagination is keyset (a.k.a. seek) on `created_at` descending: pass the
 * previous page's `nextCursor` as `cursor` to fetch the following page.
 * Keyset (not offset) so deep pages stay O(log n) and don't drift as new
 * rows arrive at the head.
 */
export interface ListJobRunsQuery {
  /** Filter to a single `pool`. */
  poolId?: string;
  /**
   * Filter to a single run tree by `root_run_id`. Used by the correlation
   * timeline to gather every run sharing a root.
   */
  rootRunId?: string;
  /** Filter to a single status. Accepts any `JobRun['status']`. */
  status?: JobRun['status'];
  /** Lower bound on `created_at` (inclusive). */
  since?: Date;
  /**
   * Opaque keyset cursor returned as `nextCursor` from a previous page.
   * Encodes the `(createdAt, id)` of the last row seen.
   */
  cursor?: string;
  /** Page size. Backend clamps to a sane default + max. */
  limit?: number;
  /**
   * Multi-tenancy gate, same semantics as `countByPoolAndStatus`:
   *   - `multiTenant` off → ignored.
   *   - on + string → filters `tenant_id = :tenantId`.
   *   - on + null   → filters `tenant_id IS NULL`.
   *   - on + undefined → throws `MissingTenantIdError`.
   */
  tenantId?: string | null;
}

/**
 * Summary row for the `job_run` list (OBS-LIST-1). A narrow projection over
 * `JobRun` carrying the columns a runs viewer renders. `rootRunId` is
 * included so the correlation timeline can stitch runs to events.
 */
export interface JobRunSummary {
  runId: string;
  rootRunId: string;
  jobType: string;
  pool: string;
  status: JobRun['status'];
  scopeEntityType: string | null;
  scopeEntityId: string | null;
  tenantId: string | null;
  attempts: number;
  errorMessage: string | null;
  runAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

/**
 * One page of `listJobRuns` results. `nextCursor` is `null` when there are
 * no more rows; otherwise pass it back as `query.cursor` for the next page.
 */
export interface JobRunPage {
  items: JobRunSummary[];
  nextCursor: string | null;
}

/**
 * Summary row for the "recent failed runs" observability widget (OBS-2). A
 * narrow projection over `JobRun` — just the fields a dashboard needs.
 */
export interface JobRunFailure {
  runId: string;
  jobType: string;
  pool: string;
  scopeEntityType: string | null;
  scopeEntityId: string | null;
  tenantId: string | null;
  attempts: number;
  errorMessage: string | null;
  failedAt: Date;
  createdAt: Date;
}

export interface IJobRunService {
  /**
   * Return runs attached to `(entityType, entityId)`. Backed by
   * `idx_job_run_scope` for efficient reads.
   */
  listForScope(
    entityType: string,
    entityId: string,
    opts?: ListForScopeOptions,
  ): Promise<JobRun[]>;

  /**
   * Cancel every non-terminal run attached to `(entityType, entityId)`,
   * cascading via `root_run_id`. Used e.g. when an Opportunity is closed
   * and all its background work should stop.
   */
  cancelForScope(
    entityType: string,
    entityId: string,
    opts?: CancelForScopeOptions,
  ): Promise<void>;

  /**
   * Push `run_at` forward on every `pending` run attached to the scope.
   * Useful for "pause this account's background work until tomorrow".
   */
  rescheduleForScope(
    entityType: string,
    entityId: string,
    newRunAt: Date,
    opts?: RescheduleForScopeOptions,
  ): Promise<void>;

  /**
   * Aggregate live counts of `job_run` rows grouped by `(pool, status)`
   * (OBS-2). Tenant gate follows the same rules as `listForScope`:
   *   - `multiTenant` off → parameter ignored.
   *   - `multiTenant` on + string → filters `tenant_id = :tenantId`.
   *   - `multiTenant` on + null   → filters `tenant_id IS NULL`.
   *   - `multiTenant` on + undefined → throws `MissingTenantIdError`.
   */
  countByPoolAndStatus(tenantId?: string | null): Promise<PoolStatusCount[]>;

  /**
   * Most-recent `failed` runs, newest first (OBS-2). `limit` is required.
   * Tenant gate follows `countByPoolAndStatus`.
   */
  listRecentFailed(
    limit: number,
    tenantId?: string | null,
  ): Promise<JobRunFailure[]>;

  /**
   * Paginated, filterable list of `job_run` rows for the observability runs
   * viewer (OBS-LIST-1). Newest first (`created_at` desc, `id` desc as the
   * keyset tie-break). Returns a `JobRunPage` with an opaque `nextCursor`
   * for keyset pagination. Tenant gate follows `countByPoolAndStatus`.
   */
  listJobRuns(query?: ListJobRunsQuery): Promise<JobRunPage>;
}
