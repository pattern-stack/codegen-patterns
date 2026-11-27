import type {
  CACHE_MODES,
  JOB_AUTHORITY_LEVELS,
  LIMITER_SCOPES,
  PAUSE_REASONS,
  RUN_STATUSES,
  RUN_TRIGGERS,
  RunSummaryValue,
  RunValue,
  STEP_KINDS,
  STEP_STATUSES,
} from '../shapes/index.ts';
import type {
  AnyJob,
  CacheMode,
  Counts,
  JobAuthorityLevel,
  PauseReason,
  Run,
  RunError,
  RunProgress,
  RunStatus,
  RunTrigger,
  StepLimiter,
  StepState,
  StepStatus,
} from '../index.ts';
import { fingerprintOf } from './fingerprint.ts';
import type { PublicJob } from './public-job-catalog.ts';

/** Whether two types are the same, both ways. */
export type Same<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

/**
 * `@pattern-stack/jobs/shapes` restates the engine's lists (it can't import `@pattern-stack/jobs`); this holds each one equal to the
 * engine's at compile time.
 */
export const WIRE_VOCABULARY_PARITY: [
  Same<RunStatus, (typeof RUN_STATUSES)[number]>,
  Same<PauseReason, (typeof PAUSE_REASONS)[number]>,
  Same<RunTrigger, (typeof RUN_TRIGGERS)[number]>,
  Same<StepStatus, (typeof STEP_STATUSES)[number]>,
  Same<StepState['kind'], (typeof STEP_KINDS)[number]>,
  Same<JobAuthorityLevel, (typeof JOB_AUTHORITY_LEVELS)[number]>,
  Same<StepLimiter['per'], (typeof LIMITER_SCOPES)[number]>,
  Same<CacheMode, (typeof CACHE_MODES)[number]>,
] = [true, true, true, true, true, true, true, true];

/** An error's type on the wire: a bounded identifier, else 'Error'. */
const ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The one sentence the wire carries for each error type; never the stored or provider text. */
const ERROR_MESSAGES: Record<string, string> = {
  RunPlanningError:
    'The run could not be planned: an input the job refused, or a step that failed outside its items.',
  JobDefinitionError: "The job's definition refused the run.",
  ResultSchemaError: "A result did not match the step's result schema.",
  ThrottledError:
    'The provider kept asking to slow down; the attempts ran out.',
  Unsettled: 'Items were left unsettled.',
};

/** The sentence for an error type with none of its own. */
const FAILED_MESSAGES: Record<'run' | 'step', string> = {
  run: 'The run failed.',
  step: 'The step failed.',
};

/** A stored error as the wire carries it: its type and a fixed sentence. `RunError.message` stays in the store. */
export function wireErrorOf(
  error: RunError | null,
  scope: 'run' | 'step',
): { type: string; message: string } | null {
  if (!error) return null;
  const type = ERROR_TYPE.test(error.type) ? error.type : 'Error';
  return {
    type,
    message: Object.hasOwn(ERROR_MESSAGES, type)
      ? (ERROR_MESSAGES[type] as string)
      : FAILED_MESSAGES[scope],
  };
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

/** A list row: the run record alone, no step reads. */
export function runSummaryOf(run: Run): RunSummaryValue {
  return {
    id: run.id,
    jobKey: run.jobKey,
    jobVersion: run.jobVersion,
    status: run.status,
    pauseReason: run.pauseReason,
    trigger: run.trigger,
    dryRun: run.dryRun,
    requestedBy: run.requestedBy,
    dedupeKey: run.dedupeKey,
    budget: {
      maxItems: run.budget.maxItems,
      maxUsd: run.budget.maxUsd ?? null,
      maxCalls: run.budget.maxCalls ?? null,
      deadlineAt: iso(run.budget.deadline ?? null),
    },
    spend: { ...run.spend },
    error: wireErrorOf(run.error, 'run'),
    createdAt: run.createdAt.toISOString(),
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
  };
}

const zeroCounts = (): Counts => ({
  total: 0,
  done: 0,
  cached: 0,
  failed: 0,
  skipped: 0,
});

type StepView = RunValue['steps'][number];

const stepViewOf = (state: StepState): StepView => ({
  name: state.name,
  index: state.index,
  kind: state.kind,
  status: state.status,
  attempts: state.attempts,
  counts: { ...state.counts },
  speculation: state.speculation ? { ...state.speculation } : null,
  wait: state.wait
    ? {
        kind: state.wait.kind,
        name: state.wait.name,
        since: state.wait.since.toISOString(),
        wakeAt: iso(state.wait.wakeAt),
      }
    : null,
  error: wireErrorOf(state.error, 'step'),
  startedAt: iso(state.startedAt),
  completedAt: iso(state.completedAt),
});

/**
 * Every step of the run in order: its stored states, and, for a run of the job's current version, a pending entry
 * for each definition step not yet started. A run of another version, or of a job this process doesn't register,
 * shows only what it stored.
 */
export function stepsOf(
  job: AnyJob | undefined,
  progress: RunProgress,
): StepView[] {
  const stored = progress.steps.map(stepViewOf);
  if (!job || progress.run.jobVersion !== job.version) return stored;
  const started = new Set(stored.map((s) => s.name));
  const pending = job.steps
    .filter((entry) => !started.has(entry.name))
    .map(
      (entry): StepView => ({
        name: entry.name,
        index: entry.index,
        kind: entry.erased.kind,
        status: 'pending',
        attempts: 0,
        counts: zeroCounts(),
        speculation: null,
        wait: null,
        error: null,
        startedAt: null,
        completedAt: null,
      }),
    );
  return [...stored, ...pending].sort((a, b) => a.index - b.index);
}

export function summedCounts(steps: StepView[]): Counts {
  const sum = zeroCounts();
  for (const step of steps)
    if (step.kind === 'map')
      for (const key of Object.keys(sum) as (keyof Counts)[])
        sum[key] += step.counts[key];
  return sum;
}

/** The revision of a view: a fingerprint of everything in it but its output (sorted keys). */
export function revisionOf(
  view: Omit<RunValue, 'output' | 'revision'>,
): string {
  return fingerprintOf(view);
}

/** One run as the API shows it. `output` is the job's public output, or null until it completed. */
export function runViewOf(
  job: PublicJob,
  progress: RunProgress,
  output: Record<string, unknown> | null,
): RunValue {
  const steps = stepsOf(job.job, progress);
  const view = {
    ...runSummaryOf(progress.run),
    counts: summedCounts(steps),
    steps,
  };
  return { ...view, output, revision: revisionOf(view) };
}
