/**
 * `@pattern-stack/jobs`: for job authors and callers. Declare a job (`defineJob`, `step`, `mapStep`), register it
 * (`createRegistry`), and start, run or control runs. Adapter authors import `@pattern-stack/jobs/ports`; tests import
 * `@pattern-stack/jobs/testing`.
 */

export {
  InProcessExecutor,
  type InProcessOptions,
  type RunOutcome,
  type RunToCompletionDeps,
  runToCompletion,
} from './adapters/in-process-executor.ts';
export { estimateTokens, localLimiter, localLimiters } from './adapters/local-limiter.ts';
export { DEFAULT_LIMITER } from './ports/limiter.ts';
export { logSink } from './adapters/log-sink.ts';
export { memorySweepCursors } from './adapters/memory-sweep-cursors.ts';
export { systemClock } from './adapters/system-clock.ts';
export {
  type ChildBudget,
  type ChildFailure,
  type ChildResults,
  type ChildrenStepDefinition,
  type ChildSpec,
  child,
  children,
} from './define/children.ts';
export {
  type AnyJob,
  defineJob,
  type JobDefinition,
  type JobOptions,
  type StepChain,
} from './define/define-job.ts';
export {
  type AdmitRequest,
  authorityAtLeast,
  JOB_AUTHORITY_LEVELS,
  type JobAudience,
  type JobAuthority,
  type JobAuthorityLevel,
  type JobLimits,
  type OutputOf,
} from './define/facts.ts';
export {
  type Gate,
  type GateContext,
  type GateOptions,
  type GatePoll,
  gate,
} from './define/gate.ts';
export {
  ITEM_VIEW_REF_IDS_MAX,
  type ItemPresenter,
  type ItemView,
  type ItemViewInput,
  type ItemViewRefs,
  itemViewRefsSchema,
  itemViewSchema,
  type StepPresenter,
  type StepView,
  type StepViewInput,
  stepViewSchema,
} from './define/item-view.ts';
export type {
  LimiterRef,
  LimiterRefs,
  StepLimiter,
} from './define/limits.ts';
export {
  type MapStepDefinition,
  type MapStepOptions,
  mapStep,
} from './define/map-step.ts';
export {
  createRegistry,
  type JobDescription,
  type Registry,
} from './define/registry.ts';
export {
  type BatchResult,
  type Effect,
  type ItemSource,
  type MapStepOutput,
  type SignalWaitOptions,
  type StepContext,
  type StepDefinition,
  type StepOptions,
  step,
  type WaitStepDefinition,
  waitFor,
} from './define/step.ts';
export { definitionVersion } from './define/version.ts';
export {
  assertResolvable,
  buildJobs,
  type DepsOf,
  type DepToken,
  type Injected,
  injected,
  isJobFactory,
  type JobEntry,
  type JobFactory,
  jobFactory,
  type ResolveDep,
  tokenOf,
} from './define/job-factory.ts';
export {
  ChildrenFailedError,
  retryChild,
  skipChild,
} from './engine/children.ts';
export { outputReader, readRunOutput } from './engine/context.ts';
export type { EmitterOptions } from './engine/emitter.ts';
export {
  type SignalRequest,
  signalAuthorityOf,
  signalRun,
} from './engine/signals.ts';
export {
  cancelRun,
  pauseRun,
  resumeRun,
  startRun,
} from './engine/start-run.ts';
export { MAX_STORED_VALUE_BYTES } from './engine/values.ts';
export { openGate } from './engine/waits.ts';
export {
  errorTypeOf,
  GateClosedError,
  GateTimedOutError,
  InputRefusedError,
  JobDefinitionError,
  JobVersionGoneError,
  NonRetryableError,
  RunNotFoundError,
  RunPlanningError,
  RunVersionConflictError,
  type SignalRefusal,
  SignalRefusedError,
  ThrottledError,
  WaitTimedOutError,
} from './model/errors.ts';
export {
  type ItemEvent,
  JOB_EVENT_TYPES,
  type JobEvent,
  type JobEventType,
  type RunEvent,
  type StepEvent,
} from './model/events.ts';
export type {
  Item,
  ItemRef,
  ItemResult,
  ItemStatus,
  Keyed,
} from './model/item.ts';
export {
  ACTIVE_RUN,
  type Budget,
  type CacheMode,
  type Collision,
  COLLISION_MODES,
  MAX_DEPTH,
  type PauseReason,
  RUN_SUBJECT_ID_MAX,
  RUN_SUBJECT_KIND_MAX,
  type Run,
  type RunError,
  type RunProgress,
  type RunRequest,
  type RunStatus,
  type RunSubject,
  type RunTrigger,
  type Spend,
  TERMINAL_RUN,
} from './model/run.ts';
export { SYSTEM_TENANT } from './model/tenant.ts';
export { withSpend } from './model/spent.ts';
export {
  type Counts,
  type Speculation,
  type StepState,
  type StepStatus,
  type StepWait,
  WAIT_KINDS,
  type WaitKind,
} from './model/step-state.ts';
export { DEFAULT_RETRY, type RetryPolicy } from './policy/retry.ts';
export type { ItemOutcome, StopPredicate } from './policy/stop.ts';
