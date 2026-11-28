import type { AnyJob, StepEntry } from '../define/define-job.ts';
import { firstClosed } from '../define/gate.ts';
import type {
  ErasedChildrenStep,
  ErasedContext,
  ErasedMapStep,
  ErasedPlainStep,
} from '../define/step.ts';
import {
  errorRecordOf,
  errorTypeOf,
  JobDefinitionError,
  JobVersionGoneError,
  RunPlanningError,
} from '../model/errors.ts';
import { budgetStop, type Run, type RunStatus } from '../model/run.ts';
import type { StepState } from '../model/step-state.ts';
import { advanceChildrenStep } from './children.ts';
import { contextFor, runOutputOf } from './context.ts';
import type { AdvanceDeps } from './deps.ts';
import { eventBase } from './emitter.ts';
import { advanceMapStep } from './run-map-step.ts';
import { runPlainStep } from './run-step.ts';
import { submitSoon } from './submit-soon.ts';
import { parkOnGate, parkOnSignal, wakeStep } from './waits.ts';

/** Where a run stands after an advance: working its chunks, or a status it rests in (`waiting` among them). */
export type AdvanceOutcome = 'chunks' | 'aborted' | RunStatus;

/** What one step's turn decided: go on to the next step, or the outcome the advance returns. */
type Turn = AdvanceOutcome | 'next';

/** What resuming a waiting step found: the outcome the turn returns, or the run and step re-read after it woke. */
type Resumed =
  | { kind: 'ends'; turn: Turn }
  | { kind: 'woke'; run: Run; state: StepState | undefined };

/** The step's context, or the failed run a context that can't be built (an input or output that won't parse) makes. */
type ContextOrFailedRun =
  | { kind: 'ctx'; ctx: ErasedContext }
  | { kind: 'failed'; outcome: AdvanceOutcome };

/**
 * The step loop, re-entrant: reads the run's records and does the next thing they call for. A completed step is
 * never run again (its recorded output is read); a plain step runs; a map step plans and waits on its chunks; the
 * budget is checked between steps; the last step's output completes the run. Deterministic given the records: no
 * clock, randomness or I/O except through the ports, so a replaying workflow makes the same calls in the same order.
 */
export async function advanceRun(
  deps: AdvanceDeps,
  runId: string,
): Promise<AdvanceOutcome> {
  const opened = await openRun(deps, runId);
  if (opened.kind === 'rests') return opened.status;
  let run = opened.run;
  const job = deps.registry.get(run.jobKey);
  for (const entry of job.steps) {
    if (deps.signal.aborted) return 'aborted';
    run = await deps.store.getRun(run.id);
    const turn = await stepTurn(deps, job, run, entry);
    if (turn !== 'next') return turn;
  }
  return complete(deps, run);
}

/**
 * Opens the run for an advance: an ended or paused run rests; a run of another version fails once its drain window
 * has passed and refuses this process before then; a pending run starts (`run.started`).
 */
async function openRun(
  deps: AdvanceDeps,
  runId: string,
): Promise<
  { kind: 'open'; run: Run } | { kind: 'rests'; status: AdvanceOutcome }
> {
  const { store, clock, events } = deps;
  const run = await store.getRun(runId);
  if (!ADVANCING.includes(run.status))
    return { kind: 'rests', status: run.status };
  const job = deps.registry.get(run.jobKey);
  if (job.version !== run.jobVersion) {
    // Past the drain window a version bump gives, the run's version is gone: fail it, never leave it open.
    if (deps.versionGone?.(run))
      return {
        kind: 'rests',
        status: await failRun(
          deps,
          run,
          new JobVersionGoneError(run.id, run.jobVersion, job.version),
        ),
      };
    throw new JobDefinitionError(
      `${job.key}: run ${run.id} was made by version ${run.jobVersion}; this process has ${job.version}`,
    );
  }
  if (run.status !== 'pending') return { kind: 'open', run };
  const started = await store.transition(run.id, {
    to: 'running',
    from: 'pending',
  });
  if (started.changed)
    await events.emit({
      ...eventBase(started.run, clock),
      type: 'run.started',
    });
  return { kind: 'open', run: started.run };
}

/** A run in one of these is advanced; any other status is where it rests. */
const ADVANCING: readonly RunStatus[] = ['pending', 'running', 'waiting'];

/**
 * One step's turn: a settled step is passed over, a failed one fails the run, a waiting one is resumed, the budget is
 * checked, then the step does its kind's work.
 */
async function stepTurn(
  deps: AdvanceDeps,
  job: AnyJob,
  current: Run,
  entry: StepEntry,
): Promise<Turn> {
  let run = current;
  if (run.status !== 'running' && run.status !== 'waiting') return run.status;
  let state = await stateOf(deps, run, entry);
  if (state?.status === 'completed' || state?.status === 'skipped')
    return 'next';
  if (state?.status === 'failed')
    return failRun(
      deps,
      run,
      new RunPlanningError(`${job.key}: step ${entry.name} failed`),
    );
  // A waiting run rests at its waiting step; the step the loop reached isn't one only after a crash between writes.
  if (run.status === 'waiting' && state?.status !== 'waiting')
    return run.status;

  let gatesRead = false;
  if (state?.status === 'waiting' && entry.erased.kind !== 'children') {
    const resumed = await resumeWait(deps, job, run, entry, state);
    if (resumed.kind === 'ends') return resumed.turn;
    ({ run, state } = resumed);
    gatesRead = true;
  }

  // Between steps (and before a step resumes): a spent budget pauses the run, never fails it.
  if (!state || entry.erased.kind === 'step') {
    const paused = await pauseIfSpent(deps, run);
    if (paused) return paused;
  }

  // A wait step has no work: it parks its run on its signal, which `signalRun` settles.
  if (entry.erased.kind === 'wait') return parkOnSignal(deps, run, entry);
  if (entry.erased.kind === 'children')
    return childrenTurn(deps, job, run, entry, state);
  return workTurn(deps, job, run, entry, state, gatesRead);
}

const stateOf = async (
  deps: AdvanceDeps,
  run: Run,
  entry: StepEntry,
): Promise<StepState | undefined> =>
  (await deps.store.stepStates(run.id)).find((s) => s.name === entry.name);

/** Builds the step's context, or fails the run when it can't be built (an input or output that won't parse). */
async function buildContextOrFailRun(
  deps: AdvanceDeps,
  job: AnyJob,
  run: Run,
  entry: StepEntry,
): Promise<ContextOrFailedRun> {
  try {
    return {
      kind: 'ctx',
      ctx: await contextFor(deps.store, job, run, entry.index, deps.signal),
    };
  } catch (err) {
    return { kind: 'failed', outcome: await failRun(deps, run, err) };
  }
}

/**
 * A waiting step's wake: it rests, its wait timed out (the step and run fail), or it woke and the run and step are
 * read again; a signal's timeout value may have settled it, and the next step reads that output.
 */
async function resumeWait(
  deps: AdvanceDeps,
  job: AnyJob,
  run: Run,
  entry: StepEntry,
  state: StepState,
): Promise<Resumed> {
  const { store, clock, events } = deps;
  const waitCtx = await buildContextOrFailRun(deps, job, run, entry);
  if (waitCtx.kind === 'failed') return { kind: 'ends', turn: waitCtx.outcome };
  const woke = await wakeStep(deps, run, entry, state, waitCtx.ctx);
  if (woke.kind === 'rests') return { kind: 'ends', turn: woke.status };
  if (woke.kind === 'fails') {
    const failure = errorRecordOf(woke.error);
    await store.failStep(run.id, entry.name, failure);
    await events.emit({
      ...eventBase(run, clock),
      type: 'step.failed',
      step: entry.name,
      attempt: state.attempts,
      errorType: failure.type,
    });
    return { kind: 'ends', turn: await failRun(deps, run, woke.error) };
  }
  const reread = await store.getRun(run.id);
  const restate = await stateOf(deps, reread, entry);
  if (reread.status !== 'running') return { kind: 'ends', turn: reread.status };
  if (restate?.status === 'completed') return { kind: 'ends', turn: 'next' };
  return { kind: 'woke', run: reread, state: restate };
}

/** A spent budget pauses the run (`run.paused`): the status it rests in, or null while budget is left. */
async function pauseIfSpent(
  deps: AdvanceDeps,
  run: Run,
): Promise<RunStatus | null> {
  const { store, clock, events } = deps;
  const reason = budgetStop(
    run.budget,
    run.spend,
    { usd: run.reservedUsd, calls: 0 },
    { usd: 0, calls: 0 },
    clock.now(),
  );
  if (!reason) return null;
  const paused = await store.transition(run.id, { to: 'paused', reason });
  if (paused.changed)
    await events.emit({
      ...eventBase(paused.run, clock),
      type: 'run.paused',
      reason,
    });
  return paused.run.status;
}

async function childrenTurn(
  deps: AdvanceDeps,
  job: AnyJob,
  run: Run,
  entry: StepEntry,
  state: StepState | undefined,
): Promise<Turn> {
  const childCtx = await buildContextOrFailRun(deps, job, run, entry);
  if (childCtx.kind === 'failed') return childCtx.outcome;
  const outcome = await advanceChildrenStep(
    deps,
    run,
    entry as StepEntry & { erased: ErasedChildrenStep },
    childCtx.ctx,
    state,
  );
  if (outcome.kind === 'failed') return failRun(deps, run, outcome.error);
  if (outcome.kind === 'rests') return outcome.status;
  return 'next';
}

/**
 * A plain or map step's work, after its gates: a plain step reads them each time it is about to run, a map step before
 * it starts (its chunks read them after that). A closed one parks the step; never a failure or a skip.
 */
async function workTurn(
  deps: AdvanceDeps,
  job: AnyJob,
  run: Run,
  entry: StepEntry,
  state: StepState | undefined,
  gatesRead: boolean,
): Promise<Turn> {
  const built = await buildContextOrFailRun(deps, job, run, entry);
  if (built.kind === 'failed') return built.outcome;
  const { ctx } = built;
  const starting =
    entry.erased.kind === 'step' || !state || state.attempts === 0;
  if (entry.erased.gates.length && starting && !gatesRead) {
    let closed: Awaited<ReturnType<typeof firstClosed>>;
    try {
      closed = await firstClosed(entry.erased.gates, ctx);
    } catch (err) {
      return failRun(deps, run, err);
    }
    if (closed)
      return parkOnGate(deps, run, entry, closed, state?.attempts ?? 0);
  }
  if (entry.erased.kind === 'step')
    return plainTurn(
      deps,
      job,
      run,
      entry as StepEntry & { erased: ErasedPlainStep },
      ctx,
    );
  const outcome = await advanceMapStep(
    deps,
    run,
    entry as StepEntry & { erased: ErasedMapStep },
    ctx,
    state,
  );
  if (outcome.kind === 'failed') return failRun(deps, run, outcome.error);
  if (outcome.kind === 'aborted' || outcome.kind === 'chunks')
    return outcome.kind;
  return 'next';
}

async function plainTurn(
  deps: AdvanceDeps,
  job: AnyJob,
  run: Run,
  entry: StepEntry & { erased: ErasedPlainStep },
  ctx: ErasedContext,
): Promise<Turn> {
  const outcome = await runPlainStep(deps, run, entry, ctx);
  switch (outcome.kind) {
    case 'aborted':
      return 'aborted';
    case 'left':
      return (await deps.store.getRun(run.id)).status;
    case 'failed':
      return failRun(deps, run, outcome.error);
    case 'gateClosed': {
      const gate = entry.erased.gates.find((g) => g.name === outcome.gate);
      if (!gate)
        return failRun(
          deps,
          run,
          new JobDefinitionError(
            `${job.key}/${entry.name}: it threw GateClosedError for ${outcome.gate}, a gate it doesn't declare`,
          ),
        );
      // Its attempt found the gate closed, so it is given back: a gate that keeps closing never exhausts a step.
      return parkOnGate(deps, run, entry, gate, outcome.attempt, {
        returnAttempt: true,
      });
    }
    default:
      return 'next';
  }
}

async function complete(deps: AdvanceDeps, run: Run): Promise<AdvanceOutcome> {
  const { store, clock, events } = deps;
  const job = deps.registry.get(run.jobKey);
  let output: unknown;
  try {
    output = await runOutputOf(store, job, run);
  } catch (err) {
    return failRun(deps, run, err);
  }
  const parsed = job.output.safeParse(output);
  if (!parsed.success)
    return failRun(
      deps,
      run,
      new JobDefinitionError(
        `${job.key}: the last step's output does not match the job's output (${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`)
          .join('; ')})`,
      ),
    );
  const done = await store.transition(run.id, { to: 'completed' });
  if (done.changed)
    await events.emit({ ...eventBase(done.run, clock), type: 'run.completed' });
  await submitParent(deps, done.run);
  return done.run.status;
}

async function failRun(
  deps: AdvanceDeps,
  run: Run,
  err: unknown,
): Promise<AdvanceOutcome> {
  const { changed, run: failed } = await deps.store.transition(run.id, {
    to: 'failed',
    error: errorRecordOf(err),
  });
  if (changed)
    await deps.events.emit({
      ...eventBase(failed, deps.clock),
      type: 'run.failed',
      errorType: errorTypeOf(err),
    });
  await submitParent(deps, failed);
  return failed.status;
}

/** A child that ended submits its parent, whose waiting step its transition made due: only the fast path. */
async function submitParent(deps: AdvanceDeps, run: Run): Promise<void> {
  if (run.parentRunId) await submitSoon(deps, run.parentRunId);
}
