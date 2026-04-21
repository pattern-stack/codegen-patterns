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
}
