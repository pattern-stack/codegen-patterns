import type {
  JobsOpsEvent,
  JobsOpsHealth,
  JobsOpsJob,
  JobsOpsRunAction,
  JobsOpsRunSummary,
} from '../shapes/ops.ts';
import { jobHealthOf } from '../shapes/ops.ts';
import type {
  AnyJob,
  JobDescription,
  Registry,
  Run,
} from '../index.ts';
import type { JobRecentRun, StoredJobEvent } from '../postgres.ts';
import { jobInputFormOf } from './job-input-form.ts';
import { runSummaryOf } from './run-view.ts';

/**
 * The operator view's projections (`@pattern-stack/jobs/shapes` shapes): the run row, a job with its health, an event and
 * an action's answer.
 */

const iso = (date: Date | null) => (date ? date.toISOString() : null);

/** A run as the operator's list row: the public run summary and its tenant. */
export function opsRunSummaryOf(run: Run): JobsOpsRunSummary {
  return {
    ...runSummaryOf(run),
    tenantId: run.tenantId,
    cache: run.cache,
    subject: run.subject ? { ...run.subject } : null,
  };
}

/**
 * An action's answer: `changed` only when the run moved into the action's status. A run that completed, failed or was
 * canceled between the read and the store's compare-and-set answers `changed: false` with the status it reached, not
 * a change the action did not make.
 */
export function actionOf(
  before: Run,
  after: Run,
  target: 'canceled' | 'paused' | 'running',
): JobsOpsRunAction {
  return {
    run: opsRunSummaryOf(after),
    changed: after.status === target && before.status !== target,
  };
}

/** A job's health as the wire carries it: the shared `jobHealthOf` over its newest runs. */
export function healthOf(runs: readonly JobRecentRun[]): JobsOpsHealth {
  const health = jobHealthOf(runs);
  return {
    window: health.window,
    open: health.open,
    completed: health.completed,
    failed: health.failed,
    canceled: health.canceled,
    successRate: health.successRate,
    durationMs: health.durationMs,
    lastRun: health.lastRun
      ? {
          id: health.lastRun.id,
          tenantId: health.lastRun.tenantId,
          status: health.lastRun.status,
          createdAt: health.lastRun.createdAt.toISOString(),
          completedAt: iso(health.lastRun.completedAt),
        }
      : null,
  };
}

export function opsEventOf(event: StoredJobEvent): JobsOpsEvent {
  return {
    id: event.id,
    runId: event.runId,
    tenantId: event.tenantId,
    jobKey: event.jobKey,
    type: event.type,
    step: event.step,
    attempt: event.attempt,
    pauseReason: event.pauseReason,
    errorType: event.errorType,
    chunk: event.chunk,
    itemKey: event.itemKey,
    waitKind: event.waitKind,
    waitName: event.waitName,
    counts: event.counts,
    at: event.at.toISOString(),
  };
}

type StepOf = JobDescription['steps'][number];
type SignalDescription = Extract<StepOf, { kind: 'wait' }>['signal'];

/** A wait step's signal as Start run's signal form asks for it. */
function signalOf(
  signal: SignalDescription,
): JobsOpsJob['steps'][number]['signal'] {
  return {
    name: signal.name,
    description: signal.description,
    authority: signal.authority,
    value: jobInputFormOf(signal.value),
    timeout: signal.timeout,
  };
}

/** One step as the operator lists it: a batch size for a map step only, a signal for a wait step only. */
function stepOf(s: StepOf): JobsOpsJob['steps'][number] {
  return {
    name: s.name,
    kind: s.kind,
    batchMax: s.kind === 'map' ? s.batchMax : null,
    limiters: s.limiters,
    signal: s.kind === 'wait' ? signalOf(s.signal) : null,
  };
}

/** A registered job as the operator lists it: its steps, authority, limits, Start run's form, and its health. */
export function jobOf(
  registry: Registry,
  job: AnyJob,
  runs: readonly JobRecentRun[],
): JobsOpsJob {
  const description = registry.describe(job.key);
  return {
    key: job.key,
    version: job.version,
    audience: job.audience,
    steps: description.steps.map(stepOf),
    authority: { ...job.authority },
    limits: job.limits ? { ...job.limits } : null,
    input: jobInputFormOf(job.input),
    health: healthOf(runs),
  };
}
