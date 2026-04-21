// ─── JOB-1: Drizzle schema (tables, enums, row types) ──────────────────────
export { jobs, jobRuns, jobSteps } from './job-orchestration.schema';
export type {
  JobDefinitionRow,
  JobRunRow,
  JobStepRow,
} from './job-orchestration.schema';
export {
  jobRunStatusEnum,
  jobStepKindEnum,
  jobStepStatusEnum,
  collisionModeEnum,
  replayFromEnum,
  parentClosePolicyEnum,
  waitKindEnum,
  triggerSourceEnum,
} from './job-orchestration.schema';

// ─── JOB-2 + JOB-8: domain tokens ──────────────────────────────────────────
export {
  JOB_ORCHESTRATOR,
  JOB_RUN_SERVICE,
  JOB_STEP_SERVICE,
  JOBS_MULTI_TENANT,
} from './jobs-domain.tokens';

// ─── JOB-2: orchestrator protocol ──────────────────────────────────────────
export type {
  IJobOrchestrator,
  StartOptions,
  CancelOptions,
  JobRun,
  JobUpsertEntry,
  JobPoolDef,
} from './job-orchestrator.protocol';

// ─── JOB-2: run-service protocol ───────────────────────────────────────────
export type {
  IJobRunService,
  ListForScopeOptions,
  CancelForScopeOptions,
  RescheduleForScopeOptions,
} from './job-run-service.protocol';

// ─── JOB-2: step-service protocol ──────────────────────────────────────────
export type {
  IJobStepService,
  RecordStepInput,
  JobStep,
} from './job-step-service.protocol';

// ─── JOB-2: handler base, decorator, registry, policy types ────────────────
export {
  ParentClosePolicy,
  JobHandlerBase,
  JobHandler,
  JOB_HANDLER_REGISTRY,
  JOB_HANDLER_METADATA_KEY,
  HandlerRegistry,
} from './job-handler.base';
export type {
  RetryPolicy,
  ConcurrencyPolicy,
  DedupePolicy,
  ScopeRef,
  JobHandlerMeta,
  StepOptions,
  SpawnChildOptions,
  JobContext,
  HandlerRegistryEntry,
} from './job-handler.base';

// ─── JOB-3: Drizzle backends + JobWorker ────────────────────────────────
export { DrizzleJobOrchestrator } from './job-orchestrator.drizzle-backend';
export { DrizzleJobRunService } from './job-run-service.drizzle-backend';
export { DrizzleJobStepService } from './job-step-service.drizzle-backend';
export {
  JobWorker,
  JOB_WORKER_OPTIONS,
  computeBackoff,
  classifyError,
  buildClaimQuery,
  buildStaleSweepQuery,
} from './job-worker';
export type { JobWorkerOptions } from './job-worker';
export {
  JobCollisionError,
  JobNotReplayableError,
  JobTemplateFieldMissingError,
  JobTypeNotFoundError,
  MissingTenantIdError,
  BootValidationError,
  ReservedPoolViolationError,
} from './jobs-errors';

// ─── JOB-4: Memory backends + shared in-memory store ───────────────────────
export { MemoryJobStore } from './memory-job-store';
export { MemoryJobOrchestrator } from './job-orchestrator.memory-backend';
export { MemoryJobRunService } from './job-run-service.memory-backend';
export { MemoryJobStepService } from './job-step-service.memory-backend';

// ─── JOB-5: domain + worker modules + pool config loader ───────────────────
export {
  JobsDomainModule,
  type JobsDomainModuleOptions,
  type DrizzleBackendExtensions,
} from './jobs-domain.module';
export {
  JobWorkerModule,
  JobWorkerOrchestrator,
  type JobWorkerModuleOptions,
} from './job-worker.module';
export {
  loadPoolConfig,
  allNonReservedPoolNames,
  FRAMEWORK_POOLS,
  RESERVED_POOL_NAMES,
  type PoolConfig,
  type PoolDefinition,
} from './pool-config.loader';
