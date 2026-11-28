/**
 * `@pattern-stack/jobs/nest`: the jobs capability in a Nest host (d83, d86–d89). One `JobsService` over the `JobActor` union,
 * with every access rule in the package; the run view, cursors, errors, public catalog and input form; the input-ref
 * port and the registry the host's domains register into; the sinks (the active span through `@opentelemetry/api`, the
 * log, the event log); and `JobsModule`, which builds the Postgres store, the BullMQ executor and the Redis limiters
 * from the handles the host binds (`tokens.ts`). `@nestjs/common` is an optional peer: one copy, the host's.
 * `@opentelemetry/api` is a dependency (it keeps one global registry across copies; with no SDK the span sink is a
 * no-op), so a host without OpenTelemetry still loads this entry.
 */

export { budgetFor } from './nest/budget.ts';
export { fanOut } from './nest/event-sinks.ts';
export {
  type JobActor,
  type JobAdminActor,
  type JobApiKeyActor,
  type JobMemberActor,
  type JobOperatorActor,
  type JobSystemActor,
  TENANT_ACTOR_LEVEL,
  type TenantJobActor,
  requesterOf,
} from './nest/job-actor.ts';
export { jobInputFormOf } from './nest/job-input-form.ts';
export {
  type JobInputRefField,
  type JobInputRefOption,
  JobInputRefRegistry,
  type JobInputRefSource,
  type JobInputRefs,
  matchingRefOptions,
  refFieldsOf,
} from './nest/job-input-refs.ts';
export {
  JobAuthorityError,
  JobBudgetOverLimitError,
  JobCursorStaleError,
  JobInputInvalidError,
  JobInputRefusedError,
  JobNotFoundError,
  JobOperatorInputRefusedError,
  JobRefNotFoundError,
  JobRunEndedError,
  JobRunNotFoundError,
  JobRunVersionConflictError,
  JobSignalValueError,
  TooManyRunWaitsError,
} from './nest/jobs.errors.ts';
export { JobsModule, type JobsModuleOptions } from './nest/jobs.module.ts';
export {
  type JobRunWithOutput,
  JobsService,
  MAX_RUN_WAITS_PER_TENANT,
  RUN_WAIT_POLL_MS,
  type SystemRunRequest,
} from './nest/jobs.service.ts';
export {
  assertRefSourcesRegistered,
  JobEngineLifecycle,
} from './nest/lifecycle.ts';
export {
  jobOpenApiSchemasOf,
  type PublicJob,
  type PublicJobCatalog,
  publicJobCatalogOf,
} from './nest/public-job-catalog.ts';
export type { StoredOutput } from './nest/run-output.ts';
export {
  JOBS_CLOCK,
  JOBS_DEFINITIONS,
  JOBS_DRIZZLE,
  JOBS_EVENT_SINKS,
  JOBS_EVENTS,
  JOBS_EXECUTOR,
  JOBS_INPUT_REFS,
  JOBS_LIMITER_CONFIG,
  JOBS_TENANTS,
  JOBS_PUBLIC_CATALOG,
  JOBS_QUEUE,
  JOBS_REDIS,
  JOBS_REGISTRY,
  JOBS_WORKER,
  JOBS_RUN_SCOPE,
  JOBS_STORE,
  JOBS_TABLES,
  type JobsTenants,
} from './nest/tokens.ts';
export type { RedisEvalClient as JobsRedisClient } from './redis.ts';
