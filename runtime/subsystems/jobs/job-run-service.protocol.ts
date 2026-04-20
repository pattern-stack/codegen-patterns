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
  cancelForScope(entityType: string, entityId: string): Promise<void>;

  /**
   * Push `run_at` forward on every `pending` run attached to the scope.
   * Useful for "pause this account's background work until tomorrow".
   */
  rescheduleForScope(
    entityType: string,
    entityId: string,
    newRunAt: Date,
  ): Promise<void>;
}
