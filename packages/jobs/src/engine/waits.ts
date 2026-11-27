import type { StepEntry } from '../define/define-job.ts';
import { type ErasedGate, firstClosed, nextPoll } from '../define/gate.ts';
import type { ErasedContext } from '../define/step.ts';
import { GateTimedOutError, WaitTimedOutError } from '../model/errors.ts';
import type { Run, RunStatus } from '../model/run.ts';
import type { StepState } from '../model/step-state.ts';
import type { Executor } from '../ports/executor.ts';
import type { JobStore } from '../ports/job-store.ts';
import type { AdvanceDeps } from './deps.ts';
import { eventBase } from './emitter.ts';
import { submitSoon } from './submit-soon.ts';

type Deps = Pick<AdvanceDeps, 'store' | 'clock' | 'events'>;

/** What a wake found: the step carries on, it waits again, or its gate timed out. */
export type WakeOutcome =
  | { kind: 'woke' }
  | { kind: 'rests'; status: RunStatus }
  | { kind: 'timedOut'; error: GateTimedOutError | WaitTimedOutError };

const kindOf = (entry: StepEntry): StepState['kind'] => entry.erased.kind;

/**
 * Parks a step on a closed gate (a CAS: the run and step must still take it), its first poll `initialPollMs` from now,
 * and says so (`step.waiting`). Returns the status the run rests in.
 */
export async function parkOnGate(
  deps: Deps,
  run: Run,
  entry: StepEntry,
  gate: ErasedGate,
  attempt: number,
  options: { returnAttempt?: boolean } = {},
): Promise<RunStatus> {
  const { store, clock, events } = deps;
  const wakeAt = new Date(clock.now().getTime() + gate.initialPollMs);
  const parked = await store.park(
    run.id,
    { name: entry.name, index: entry.index, kind: kindOf(entry) },
    {
      kind: 'gate',
      name: gate.name,
      wakeAt,
      returnAttempt: options.returnAttempt,
    },
  );
  if (!parked) return (await store.getRun(run.id)).status;
  await events.emit({
    ...eventBase(run, clock),
    type: 'step.waiting',
    step: entry.name,
    attempt,
    waitKind: 'gate',
    waitName: gate.name,
    wakeAt,
  });
  return 'waiting';
}

/**
 * Parks a wait step on its signal (a CAS, as a gate's), its `wakeAt` the timeout when it has one, and says so
 * (`step.waiting`). Returns the status the run rests in.
 */
export async function parkOnSignal(
  deps: Deps,
  run: Run,
  entry: StepEntry,
): Promise<RunStatus> {
  const { store, clock, events } = deps;
  if (entry.erased.kind !== 'wait') return run.status;
  const { signal, timeout } = entry.erased;
  const wakeAt = timeout
    ? new Date(clock.now().getTime() + timeout.afterMs)
    : null;
  const parked = await store.park(
    run.id,
    { name: entry.name, index: entry.index, kind: 'wait' },
    { kind: 'signal', name: signal, wakeAt },
  );
  if (!parked) return (await store.getRun(run.id)).status;
  await events.emit({
    ...eventBase(run, clock),
    type: 'step.waiting',
    step: entry.name,
    attempt: 0,
    waitKind: 'signal',
    waitName: signal,
    wakeAt,
  });
  return 'waiting';
}

/**
 * A signal wait that the advance reached: a signal settles it (`signalRun`), so the advance only meets its timeout.
 * Before `wakeAt` (or with none) it rests, parked again after a resume; past it, `fallback: 'fail'` fails the step and a
 * default value settles it as a signal would (`step.signaled`, `byTimeout`).
 */
async function wakeSignal(
  deps: Deps,
  run: Run,
  entry: StepEntry,
  state: StepState,
): Promise<WakeOutcome> {
  const { store, clock, events } = deps;
  const wait = state.wait;
  if (entry.erased.kind !== 'wait' || wait?.kind !== 'signal')
    return { kind: 'rests', status: run.status };
  const now = clock.now();
  if (!wait.wakeAt || wait.wakeAt > now) {
    if (run.status === 'running')
      await store.park(
        run.id,
        { name: entry.name, index: entry.index, kind: 'wait' },
        { kind: 'signal', name: wait.name, wakeAt: wait.wakeAt },
      );
    return { kind: 'rests', status: (await store.getRun(run.id)).status };
  }
  const fallback = entry.erased.timeout?.fallback ?? 'fail';
  const waited = now.getTime() - wait.since.getTime();
  if (fallback === 'fail')
    return {
      kind: 'timedOut',
      error: new WaitTimedOutError(wait.name, waited),
    };
  if (
    await store.settleWait(run.id, entry.name, {
      signal: wait.name,
      output: fallback.value,
      by: null,
    })
  )
    await events.emit({
      ...eventBase(run, clock),
      type: 'step.signaled',
      step: entry.name,
      attempt: state.attempts,
      waitKind: 'signal',
      waitName: wait.name,
      byTimeout: true,
    });
  return { kind: 'woke' };
}

/**
 * The advance at a waiting step. A signal wait goes to `wakeSignal`. A gate wait: before its `wakeAt` it rests (a run resumed from a pause
 * parks again with the same wake); once due, its gates are read again: all open → the step carries on (`unpark`,
 * `step.woke`); one closed → it waits again, as long as it has waited so far (1 min up to 15 by default), or fails
 * past the gate's `maxWaitMs`. A wake-up never decides anything itself: this read does.
 */
export async function wakeStep(
  deps: Deps,
  run: Run,
  entry: StepEntry,
  state: StepState,
  ctx: ErasedContext,
): Promise<WakeOutcome> {
  const { store, clock, events } = deps;
  const wait = state.wait;
  if (wait?.kind === 'signal') return wakeSignal(deps, run, entry, state);
  if (wait?.kind !== 'gate') return { kind: 'rests', status: run.status };
  const now = clock.now();
  const step = { name: entry.name, index: entry.index, kind: kindOf(entry) };
  if (wait.wakeAt && wait.wakeAt > now) {
    if (run.status === 'running')
      await store.park(run.id, step, {
        kind: 'gate',
        name: wait.name,
        wakeAt: wait.wakeAt,
      });
    return { kind: 'rests', status: (await store.getRun(run.id)).status };
  }
  const closed = await firstClosed(entry.erased.gates, ctx);
  if (!closed) {
    if (await store.unpark(run.id, entry.name))
      await events.emit({
        ...eventBase(run, clock),
        type: 'step.woke',
        step: entry.name,
        attempt: state.attempts,
        waitKind: 'gate',
        waitName: wait.name,
      });
    return { kind: 'woke' };
  }
  const since = closed.name === wait.name ? wait.since : now;
  const waited = now.getTime() - since.getTime();
  if (closed.maxWaitMs !== undefined && waited >= closed.maxWaitMs)
    return {
      kind: 'timedOut',
      error: new GateTimedOutError(closed.name, waited),
    };
  if (closed.name !== wait.name)
    return {
      kind: 'rests',
      status: await parkOnGate(deps, run, entry, closed, state.attempts),
    };
  await store.park(run.id, step, {
    kind: 'gate',
    name: closed.name,
    wakeAt: nextPoll(closed, since, now),
  });
  return { kind: 'rests', status: (await store.getRun(run.id)).status };
}

/**
 * A gate's push: every step of the tenant waiting on `name` is due now, and each waiting run is submitted, so
 * its next advance reads the gate again. The submit is only the fast path: the steps are already due, so a submit that
 * fails is picked up by the next sweep. Returns the runs it woke. Polling stays the backstop for a push never sent.
 */
export async function openGate(
  deps: { store: JobStore; executor: Pick<Executor, 'submit'> },
  tenantId: string,
  name: string,
): Promise<string[]> {
  const woken = await deps.store.wakeGate(tenantId, name);
  for (const runId of woken) await submitSoon(deps.executor, runId);
  return woken;
}
