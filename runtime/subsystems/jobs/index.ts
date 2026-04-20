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

// ─── JOB-2: domain tokens ──────────────────────────────────────────────────
export {
  JOB_ORCHESTRATOR,
  JOB_RUN_SERVICE,
  JOB_STEP_SERVICE,
} from './jobs-domain.tokens';

// ─── JOB-2: orchestrator protocol ──────────────────────────────────────────
export type {
  IJobOrchestrator,
  StartOptions,
  CancelOptions,
  JobRun,
} from './job-orchestrator.protocol';

// ─── JOB-2: run-service protocol ───────────────────────────────────────────
export type {
  IJobRunService,
  ListForScopeOptions,
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
} from './jobs-errors';

// ─── JOB-4: Memory backends + shared in-memory store ───────────────────────
export { MemoryJobStore } from './memory-job-store';
export { MemoryJobOrchestrator } from './job-orchestrator.memory-backend';
export { MemoryJobRunService } from './job-run-service.memory-backend';
export { MemoryJobStepService } from './job-step-service.memory-backend';

// Subsequent issues add: modules (JOB-5).
// All net-new — nothing from the old executor layer survives.
