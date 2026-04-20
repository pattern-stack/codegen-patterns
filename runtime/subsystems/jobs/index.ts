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

// Subsequent issues add: backends (JOB-3, JOB-4), modules (JOB-5).
// All net-new — nothing from the old executor layer survives.
