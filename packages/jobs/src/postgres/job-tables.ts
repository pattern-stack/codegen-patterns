import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { ChunkStatus } from '../model/chunk.ts';
import type { JobEventType } from '../model/events.ts';
import type { ItemStatus } from '../model/item.ts';
import type {
  CacheMode,
  PauseReason,
  RunStatus,
  RunTrigger,
} from '../model/run.ts';
import type { StepStatus, WaitKind } from '../model/step-state.ts';

/**
 * A column the store reads and writes, by its TS data type and nullability. A table whose column holds another type
 * (a renamed status, a widened varchar) fails `satisfies JobTables` where the backend binds the tables.
 */
type Column<T, NotNull extends boolean = true> = AnyPgColumn & {
  readonly _: { readonly data: T; readonly notNull: NotNull };
};
type Nullable<T> = Column<T, false>;

type Counts = {
  itemsTotal: Column<number>;
  itemsDone: Column<number>;
  itemsCached: Column<number>;
  itemsFailed: Column<number>;
  itemsSkipped: Column<number>;
};

/**
 * The tables the Postgres store is handed: the four bookkeeping tables, the two that hold a job's values as JSON
 * (`values`: a run's input and its steps' outputs; `results`: map steps' item results), and the event log (`events`,
 * written by `appendEvent`, read by the operator reads). They are declared in
 * `packages/db` (`schemas/jobs.ts`); this package never imports them, and the backend binds them once with
 * `satisfies JobTables`.
 */
export interface JobTables {
  runs: PgTable & {
    id: Column<string>;
    tenantId: Column<string>;
    jobKey: Column<string>;
    jobVersion: Column<string>;
    status: Column<RunStatus>;
    pauseReason: Nullable<PauseReason>;
    trigger: Column<RunTrigger>;
    requestedByUserId: Nullable<string>;
    dryRun: Column<boolean>;
    dedupeKey: Nullable<string>;
    subjectKind: Nullable<string>;
    subjectId: Nullable<string>;
    cacheMode: Column<CacheMode>;
    chunkSize: Column<number>;
    chunkConcurrency: Nullable<number>;
    maxItems: Column<number>;
    maxUsd: Nullable<number>;
    maxCalls: Nullable<number>;
    deadlineAt: Nullable<Date>;
    calls: Column<number>;
    inputTokens: Column<number>;
    costUsd: Column<number>;
    parentRunId: Nullable<string>;
    parentStep: Nullable<string>;
    childKey: Nullable<string>;
    depth: Column<number>;
    errorType: Nullable<string>;
    errorMessage: Nullable<string>;
    createdAt: Column<Date>;
    startedAt: Nullable<Date>;
    completedAt: Nullable<Date>;
    updatedAt: Column<Date>;
    advanceOwner: Nullable<string>;
    advanceToken: Nullable<string>;
    advanceExpiresAt: Nullable<Date>;
  };
  steps: PgTable &
    Counts & {
      runId: Column<string>;
      tenantId: Column<string>;
      name: Column<string>;
      stepIndex: Column<number>;
      kind: Column<'step' | 'map' | 'wait' | 'children'>;
      status: Column<StepStatus>;
      attempts: Column<number>;
      planned: Column<boolean>;
      sourceCursor: Nullable<string>;
      speculated: Nullable<number>;
      used: Nullable<number>;
      overshoot: Nullable<number>;
      waitKind: Nullable<WaitKind>;
      waitName: Nullable<string>;
      waitSince: Nullable<Date>;
      wakeAt: Nullable<Date>;
      settledByUserId: Nullable<string>;
      errorType: Nullable<string>;
      errorMessage: Nullable<string>;
      startedAt: Nullable<Date>;
      completedAt: Nullable<Date>;
      updatedAt: Column<Date>;
    };
  items: PgTable & {
    runId: Column<string>;
    tenantId: Column<string>;
    step: Column<string>;
    ordinal: Column<number>;
    /** Null only for a children step's slot (a later slice), which has no chunk. */
    chunkIndex: Nullable<number>;
    itemKey: Column<string>;
    itemRef: Column<string>;
    status: Column<ItemStatus>;
    attempts: Column<number>;
    errorType: Nullable<string>;
  };
  chunks: PgTable &
    Counts & {
      runId: Column<string>;
      tenantId: Column<string>;
      step: Column<string>;
      chunkIndex: Column<number>;
      status: Column<ChunkStatus>;
      attempts: Column<number>;
      runAt: Column<Date>;
      leaseOwner: Nullable<string>;
      leaseToken: Nullable<string>;
      leaseExpiresAt: Nullable<Date>;
      calls: Column<number>;
      inputTokens: Column<number>;
      costUsd: Column<number>;
      reservedUsd: Column<number>;
      reservedCalls: Column<number>;
      lastErrorType: Nullable<string>;
      lastErrorMessage: Nullable<string>;
      startedAt: Nullable<Date>;
      completedAt: Nullable<Date>;
      updatedAt: Column<Date>;
    };
  values: PgTable & {
    runId: Column<string>;
    tenantId: Column<string>;
    name: Column<string>;
    value: Column<unknown>;
    createdAt: Column<Date>;
  };
  events: PgTable & {
    id: Column<string>;
    tenantId: Column<string>;
    runId: Column<string>;
    jobKey: Column<string>;
    type: Column<JobEventType>;
    step: Nullable<string>;
    attempt: Nullable<number>;
    pauseReason: Nullable<PauseReason>;
    errorType: Nullable<string>;
    chunkIndex: Nullable<number>;
    itemKey: Nullable<string>;
    itemsTotal: Nullable<number>;
    itemsDone: Nullable<number>;
    itemsCached: Nullable<number>;
    itemsFailed: Nullable<number>;
    itemsSkipped: Nullable<number>;
    waitKind: Nullable<WaitKind>;
    waitName: Nullable<string>;
    childRunId: Nullable<string>;
    at: Column<Date>;
  };
  results: PgTable & {
    tenantId: Column<string>;
    scope: Column<string>;
    itemKey: Column<string>;
    itemRef: Column<string>;
    result: Column<unknown>;
    runId: Column<string>;
    createdAt: Column<Date>;
  };
}
