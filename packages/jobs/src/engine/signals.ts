import { inScope, type RunScope } from '../ports/run-scope.ts';
import type { AnyJob } from '../define/define-job.ts';
import type { JobAuthorityLevel } from '../define/facts.ts';
import type { Registry } from '../define/registry.ts';
import type { ErasedWaitStep } from '../define/step.ts';
import { SignalRefusedError } from '../model/errors.ts';
import { type Run, TERMINAL_RUN } from '../model/run.ts';
import type { Clock } from '../ports/clock.ts';
import type { EventSink } from '../ports/event-sink.ts';
import type { Executor } from '../ports/executor.ts';
import type { JobStore } from '../ports/job-store.ts';
import { contextFor } from './context.ts';
import { eventBase } from './emitter.ts';
import { submitSoon } from './submit-soon.ts';
import { assertStorable } from './values.ts';

/** A signal for a run's waiting step: its name, its value, and who sent it (null for a system sender). */
export interface SignalRequest {
  runId: string;
  step: string;
  signal: string;
  value: unknown;
  by: string | null;
}

/** The wait step named `step` of `job` waiting on `signal`, or `wait_not_open`. */
function waitStepOf(job: AnyJob, step: string, signal: string): ErasedWaitStep {
  const entry = job.steps.find((s) => s.name === step);
  if (entry?.erased.kind !== 'wait' || entry.erased.signal !== signal)
    throw new SignalRefusedError(
      'wait_not_open',
      `${job.key} has no step ${step} waiting for ${signal}`,
    );
  return entry.erased;
}

/**
 * Who may send a wait step's signal: its own `authority`, else the level that started the run (the job's
 * `authority.start`, or `authority.dryRun` for a dry run). A surface applies it to its caller before `signalRun`.
 */
export function signalAuthorityOf(
  job: AnyJob,
  run: Run,
  step: string,
): JobAuthorityLevel {
  const entry = job.steps.find((s) => s.name === step);
  const own =
    entry?.erased.kind === 'wait' ? entry.erased.authority : undefined;
  return own ?? (run.dryRun ? job.authority.dryRun : job.authority.start);
}

/**
 * Delivers a signal to a run's waiting step: the value is parsed by the step's schema (`signal_value_invalid`, with
 * each issue's path and code, never the value), checked by its `accept` (`InputRefusedError`, its own code), checked
 * storable, then settled in one write (`store.settleWait`: the first signal wins; a step not waiting for it is
 * `wait_not_open`). It emits `step.signaled` and submits the run, whose next advance reads the value as the step's
 * output. A paused run records the signal and stays paused. The caller applies the sender's authority first
 * (`signalAuthorityOf`). Signals are not buffered: one that arrives before its step waits is refused.
 */
export async function signalRun(
  deps: {
    store: JobStore;
    registry: Registry;
    clock: Clock;
    events: EventSink;
    executor?: Pick<Executor, 'submit'>;
    /** Wraps `accept` in the run's scope (`RunScope`). */
    around?: RunScope;
  },
  request: SignalRequest,
): Promise<{ run: Run }> {
  const { store, registry, clock, events } = deps;
  const run = await store.getRun(request.runId);
  // An ended run keeps its waiting step's row as it was; its wait is not open.
  if (TERMINAL_RUN.includes(run.status))
    throw new SignalRefusedError(
      'wait_not_open',
      `run ${run.id} is ${run.status}: its waits are closed`,
    );
  const job = registry.get(run.jobKey);
  const wait = waitStepOf(job, request.step, request.signal);
  const state = (await store.stepStates(run.id)).find(
    (s) => s.name === request.step,
  );
  if (
    state?.status !== 'waiting' ||
    state.wait?.kind !== 'signal' ||
    state.wait.name !== request.signal
  )
    throw new SignalRefusedError(
      'wait_not_open',
      `step ${request.step} is not waiting for ${request.signal}`,
    );
  const parsed = wait.value.safeParse(request.value);
  if (!parsed.success)
    throw new SignalRefusedError(
      'signal_value_invalid',
      `the ${request.signal} signal's value does not match its schema`,
      parsed.error.issues.map((i) => ({
        path: i.path.join('.') || '(root)',
        code: i.code,
      })),
    );
  if (wait.accept) {
    const entry = job.steps.find((s) => s.name === request.step);
    const ctx = await contextFor(
      store,
      job,
      run,
      entry?.index ?? 0,
      new AbortController().signal,
    );
    const accept = wait.accept;
    await inScope(
      deps.around,
      { runId: run.id, tenantId: run.tenantId, jobKey: run.jobKey },
      () => accept(parsed.data, ctx),
    );
  }
  assertStorable(parsed.data, `the ${request.signal} signal's value`);
  const settled = await store.settleWait(run.id, request.step, {
    signal: request.signal,
    output: parsed.data,
    by: request.by,
  });
  if (!settled)
    throw new SignalRefusedError(
      'wait_not_open',
      `step ${request.step} is not waiting for ${request.signal}`,
    );
  await events.emit({
    ...eventBase(run, clock),
    type: 'step.signaled',
    step: request.step,
    attempt: state.attempts,
    waitKind: 'signal',
    waitName: request.signal,
    byTimeout: false,
  });
  const after = await store.getRun(run.id);
  // Only the fast path: the step is settled and the run running, so the sweep's open-run read finds it if this fails.
  if (after.status === 'running') await submitSoon(deps.executor, run.id);
  return { run: after };
}
