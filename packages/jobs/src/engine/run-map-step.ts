import type { StepEntry } from '../define/define-job.ts';
import type { ErasedContext, ErasedMapStep } from '../define/step.ts';
import { errorRecordOf, errorTypeOf } from '../model/errors.ts';
import type { Run } from '../model/run.ts';
import type { Counts, StepState } from '../model/step-state.ts';
import { speculationOf } from '../policy/stop.ts';
import type { JobStore } from '../ports/job-store.ts';
import type { AdvanceDeps } from './deps.ts';
import { eventBase } from './emitter.ts';
import { readStop, type StopScans } from './stop-scan.ts';

export type MapStepOutcome =
  | { kind: 'completed' }
  | { kind: 'chunks' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'aborted' };

const stateOf = async (store: JobStore, runId: string, name: string) =>
  (await store.stepStates(runId)).find((s) => s.name === name);

/** Whether a map step's early stop is found yet, without stopping it: a chunk reads it between its batches. */
export async function stopFound(
  store: JobStore,
  run: Run,
  name: string,
  erased: ErasedMapStep,
  scans?: StopScans,
): Promise<boolean> {
  return (await readStop(store, run, name, erased, scans)) !== null;
}

/**
 * Reads a map step's early stop over its settled prefix, and once found, stops the step (its items past the stop
 * skipped, its open chunks canceled, its planning ended). Idempotent and deterministic: the same records give the
 * same stop. Returns the items the result keeps, or null while no stop is found (or the step has none). The read is
 * incremental through `scans` (`readStop`), and the step's counts say whether anything is left to stop.
 */
export async function applyStop(
  store: JobStore,
  run: Run,
  name: string,
  erased: ErasedMapStep,
  scans?: StopScans,
): Promise<number | null> {
  const used = await readStop(store, run, name, erased, scans);
  if (used === null) return null;
  // Every item before the stop is settled, so a pending item is one past it. Stop while one is left, or while the
  // step still plans (a stop ends its planning).
  const state = await stateOf(store, run.id, name);
  if (!state?.planned || (state && pendingOf(state.counts) > 0))
    await store.stopStep(run.id, name, used);
  return used;
}

const pendingOf = (c: Counts) =>
  c.total - c.done - c.cached - c.failed - c.skipped;

/**
 * Advances a map step as far as it can go now: start it, plan its items into chunks (from its cursor, after a
 * crash; a stop found meanwhile ends the planning), read its early stop over the settled prefix, and complete it once every chunk settled or the stop was
 * found. Chunks themselves are processed by the executor, which advances the run again as they settle.
 */
export async function advanceMapStep(
  deps: AdvanceDeps,
  run: Run,
  entry: StepEntry & { erased: ErasedMapStep },
  ctx: ErasedContext,
  existing: StepState | undefined,
): Promise<MapStepOutcome> {
  const { store, clock, events } = deps;
  const { erased, name } = entry;
  let state = existing;
  // A step parked on a gate before it started holds a row with no attempt: it starts now.
  if (!state || state.attempts === 0) {
    const started = await store.startStep(
      run.id,
      { name, index: entry.index, kind: 'map' },
      { attempts: 0 },
    );
    // Another advance started it first: it plans the step, and this one leaves it to the chunks.
    if (!started) return { kind: 'chunks' };
    state = started;
    await events.emit({
      ...eventBase(run, clock),
      type: 'step.started',
      step: name,
      attempt: state.attempts,
    });
  }
  const base = () => ({
    ...eventBase(run, clock),
    step: name,
    attempt: state?.attempts ?? 1,
  });

  if (!state.planned) {
    const planned = await planStep(deps, run, entry, ctx, state);
    if (planned.kind !== 'planned') return planned;
    state = planned.state;
  }

  if (state.counts.total === 0) {
    await store.recordStep(run.id, name, { status: 'skipped' });
    await events.emit({ ...base(), type: 'step.skipped' });
    return { kind: 'completed' };
  }

  const used = await applyStop(store, run, name, erased, deps.stops);
  if (used !== null) {
    const stopped = await stateOf(store, run.id, name);
    if (stopped) state = stopped;
  }

  if (state.chunks.pending + state.chunks.running > 0)
    return { kind: 'chunks' };
  const { done, cached, failed, total } = state.counts;
  const speculation = speculationOf(done + cached + failed, used ?? total);
  await store.recordStep(run.id, name, { status: 'completed', speculation });
  deps.stops?.drop(run.id, name);
  const final = await stateOf(store, run.id, name);
  await events.emit({
    ...base(),
    type: 'step.completed',
    counts: final?.counts ?? state.counts,
    speculation,
  });
  return { kind: 'completed' };
}

/**
 * Plans a map step's items page by page from its source, up to the run's `maxItems`: its state once planned, or how
 * the advance leaves it (a cancel or pause under the planner, an abort, or a failed source that fails the step).
 */
async function planStep(
  deps: AdvanceDeps,
  run: Run,
  entry: StepEntry & { erased: ErasedMapStep },
  ctx: ErasedContext,
  from: StepState,
): Promise<{ kind: 'planned'; state: StepState } | MapStepOutcome> {
  const { store, clock, events, signal } = deps;
  const { erased, name } = entry;
  let state = from;
  try {
    const source = await erased.source(ctx);
    while (!state.planned) {
      if (signal.aborted) return { kind: 'aborted' };
      const limit = Math.min(
        deps.pageSize ?? 1_000,
        run.budget.maxItems - state.counts.total,
      );
      const page =
        limit > 0
          ? await source.page(state.sourceCursor, limit, signal)
          : { refs: [], next: null };
      await store.planItems(run.id, name, {
        refs: page.refs,
        keys: page.refs.map((r) => erased.key(r, ctx)),
        next: page.next,
      });
      deps.onChange?.();
      const next = await stateOf(store, run.id, name);
      if (!next) throw new Error(`step ${name} lost its state`);
      // The run left running under the planner (a cancel or a pause): stop planning; the next advance resumes it.
      if (!next.planned && next.counts.total === state.counts.total) {
        const current = await store.getRun(run.id);
        if (current.status !== 'running') return { kind: 'chunks' };
      }
      state = next;
    }
    return { kind: 'planned', state };
  } catch (err) {
    if (signal.aborted) return { kind: 'aborted' };
    await store.failStep(run.id, name, errorRecordOf(err));
    await events.emit({
      ...eventBase(run, clock),
      step: name,
      attempt: state.attempts,
      type: 'step.failed',
      errorType: errorTypeOf(err),
    });
    return { kind: 'failed', error: err };
  }
}
