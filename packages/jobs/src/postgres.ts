/**
 * `@pattern-stack/jobs/postgres`: the durable store on Postgres. Its tables are `./postgres/tables.ts` (an app's schema
 * re-exports them, so its migrations create them) and the store is handed them (`jobTables`, typed `JobTables`); `drizzle-orm` is an optional peer, so the core and its other entries never load it.
 */

export { eventLogSink } from './postgres/event-log-sink.ts';
export type { JobTables } from './postgres/tables.ts';
export type {
  EventLogQuery,
  ItemKey,
  JobOperatorReads,
  JobRecentRun,
  OperatorItem,
  OperatorRunQuery,
  RunEventQuery,
  RunItemQuery,
  StoredJobEvent,
  TimeKey,
} from './postgres/operator-reads.ts';
export {
  type JobDatabase,
  PostgresJobStore,
  type PostgresJobStoreOptions,
} from './postgres/postgres-job-store.ts';
export {
  jobItemResults,
  jobRunChunks,
  jobRunEvents,
  jobRunItems,
  jobRunSteps,
  jobRuns,
  jobRunValues,
  jobTables,
} from './postgres/tables.ts';
