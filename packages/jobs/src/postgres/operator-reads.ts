import type { JobEventType } from '../model/events.ts';
import type { ItemStatus } from '../model/item.ts';
import type { PauseReason, Run, RunStatus, RunSubject } from '../model/run.ts';
import type { Counts, WaitKind } from '../model/step-state.ts';

/**
 * The operator reads: methods on `PostgresJobStore` for a superuser surface only, off the `JobStore` port (as
 * `listRecentAcrossTenants` is). They read across tenants; the surface that calls them holds the
 * superuser gate. Each is bounded: keyset paged or one row per job.
 */

/** A keyset position over rows ordered by time, then id. */
export interface TimeKey {
  at: Date;
  id: string;
}

/** Runs across tenants, newest first, filtered by job, tenant, status and subject. */
export interface OperatorRunQuery {
  jobKey?: string;
  tenantId?: string;
  status?: RunStatus;
  /** What the runs are about (`Run.subject`); fast with a tenant (`job_runs_tenant_subject_created_idx`). */
  subject?: RunSubject;
  /** Only the children of this run. */
  parentRunId?: string;
  /** Continue after this run (exclusive), newest first. */
  before?: TimeKey;
  limit: number;
}

/** One of a job's newest runs, as its health reads it (`jobHealthOf` in `@pattern-stack/jobs/shapes`). */
export interface JobRecentRun {
  jobKey: string;
  id: string;
  tenantId: string;
  status: RunStatus;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** Where an item page continues: failed items (rank 0) come before the rest (rank 1), each by ordinal. */
export interface ItemKey {
  rank: 0 | 1;
  ordinal: number;
}

export interface RunItemQuery {
  runId: string;
  step: string;
  status?: ItemStatus;
  after?: ItemKey;
  limit: number;
}

export interface OperatorItem {
  ordinal: number;
  /** Null for a children step's slot. */
  chunkIndex: number | null;
  key: string;
  ref: string;
  status: ItemStatus;
  attempts: number;
  errorType: string | null;
}

/** One stored engine event: ids, counts and types, never content. */
export interface StoredJobEvent {
  id: string;
  runId: string;
  tenantId: string;
  jobKey: string;
  type: JobEventType;
  step: string | null;
  attempt: number | null;
  pauseReason: PauseReason | null;
  errorType: string | null;
  chunk: number | null;
  itemKey: string | null;
  /** A wait's kind and name (`step.waiting`, `step.woke`); null on every other event. */
  waitKind: WaitKind | null;
  waitName: string | null;
  counts: Counts | null;
  at: Date;
}

/** A run's events, oldest first. */
export interface RunEventQuery {
  runId: string;
  after?: TimeKey;
  limit: number;
}

/** The event log across tenants, newest first. */
export interface EventLogQuery {
  jobKey?: string;
  tenantId?: string;
  type?: JobEventType;
  before?: TimeKey;
  limit: number;
}

/**
 * The operator reads across tenants: methods on `PostgresJobStore`, off the `JobStore` port, which implements
 * this interface so drift is a compile error. A superuser surface only. Each is bounded.
 */
export interface JobOperatorReads {
  /** Recent runs of these jobs. */
  listRecentAcrossTenants(filter: {
    jobKeys: readonly string[];
    limit: number;
  }): Promise<Run[]>;
  /** Runs, newest first, filtered and keyset paged. */
  listRunsAcrossTenants(query: OperatorRunQuery): Promise<Run[]>;
  /** Each job's newest `perJob` runs, in one query; health is the shared `jobHealthOf` over them. */
  listNewestRunsPerJob(
    jobKeys: readonly string[],
    perJob: number,
  ): Promise<JobRecentRun[]>;
  /** A step's items, failed first, then the rest, each by ordinal. */
  listRunItems(query: RunItemQuery): Promise<OperatorItem[]>;
  /** A run's events, oldest first. */
  listRunEvents(query: RunEventQuery): Promise<StoredJobEvent[]>;
  /** The event log, newest first. */
  listEvents(query: EventLogQuery): Promise<StoredJobEvent[]>;
}
