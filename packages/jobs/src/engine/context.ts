import type { ChildResults } from '../define/children.ts';
import type { AnyJob, StepEntry } from '../define/define-job.ts';
import type { OutputOf } from '../define/facts.ts';
import type { Registry } from '../define/registry.ts';
import type {
  ErasedChildrenStep,
  ErasedContext,
  ErasedMapStep,
  MapStepOutput,
} from '../define/step.ts';
import {
  InputRefusedError,
  RunNotFoundError,
  RunPlanningError,
} from '../model/errors.ts';
import type { Item } from '../model/item.ts';
import type { Run } from '../model/run.ts';
import type { StepState } from '../model/step-state.ts';
import type { ItemOutcome } from '../policy/stop.ts';
import type { JobStore } from '../ports/job-store.ts';
import { inputOf, resultsOf } from './values.ts';

const SETTLED = new Set(['done', 'cached', 'failed']);

/**
 * A map step's items in planned order as its stop reads them: the contiguous settled prefix only, so an item the
 * engine worked ahead to is never read before every item in front of it settled.
 */
export async function settledPrefix(
  store: JobStore,
  run: Run,
  step: string,
  erased: ErasedMapStep,
  items: readonly Item[],
  limit = Number.POSITIVE_INFINITY,
): Promise<ItemOutcome<unknown>[]> {
  return outcomesOf(store, run, step, erased, settledRun(items, limit));
}

/** The settled items at the front of `items`, in order, stopping at the first unsettled one (or at `limit`). */
export function settledRun(
  items: readonly Item[],
  limit = Number.POSITIVE_INFINITY,
): Item[] {
  const prefix: Item[] = [];
  for (const item of items) {
    if (prefix.length >= limit || !SETTLED.has(item.status)) break;
    prefix.push(item);
  }
  return prefix;
}

/** Settled items as the stop reads them, each with its stored result (a failed one with its error type). */
export async function outcomesOf(
  store: JobStore,
  run: Run,
  step: string,
  erased: ErasedMapStep,
  prefix: readonly Item[],
): Promise<ItemOutcome<unknown>[]> {
  const results = await resultsOf(
    store,
    run,
    step,
    erased,
    prefix.filter((i) => i.status !== 'failed').map((i) => i.key),
  );
  return prefix.map((i): ItemOutcome<unknown> => {
    if (i.status === 'failed')
      return {
        key: i.key,
        ref: i.ref,
        ok: false,
        errorType: i.errorType ?? 'Error',
      };
    if (!results.has(i.key))
      throw new RunPlanningError(
        `${run.jobKey}/${step}: item ${i.key} is ${i.status} with no stored result`,
      );
    return { key: i.key, ref: i.ref, ok: true, result: results.get(i.key) };
  });
}

/** A completed map step's output, read back from its items and stored results: never re-run. */
export async function mapOutputOf(
  store: JobStore,
  run: Run,
  name: string,
  erased: ErasedMapStep,
  state: StepState,
): Promise<MapStepOutput<unknown>> {
  const items = await store.items(run.id, name);
  const used = state.speculation?.used ?? items.length;
  const outcomes = await settledPrefix(store, run, name, erased, items, used);
  if (outcomes.length < Math.min(used, items.length))
    throw new RunPlanningError(
      `${run.jobKey}/${name}: completed with unsettled items`,
    );
  const output: MapStepOutput<unknown> = { results: [], failed: [] };
  for (const o of outcomes)
    if (o.ok) output.results.push({ key: o.key, ref: o.ref, result: o.result });
    else output.failed.push({ key: o.key, ref: o.ref, errorType: o.errorType });
  return output;
}

/** A completed step's output: a map step's from its items, a plain step's from its recorder or the store. */
export async function stepOutputOf(
  store: JobStore,
  run: Run,
  entry: StepEntry,
  state: StepState,
): Promise<unknown> {
  if (state.status === 'skipped') return { results: [], failed: [] };
  if (entry.erased.kind === 'map')
    return mapOutputOf(store, run, entry.name, entry.erased, state);
  // A signal's value is the step's output, kept by the store.
  if (entry.erased.kind === 'wait') return store.stepOutput(run.id, entry.name);
  if (entry.erased.kind === 'children')
    return childrenOutputOf(store, run, entry.name, entry.erased);
  if (entry.erased.recorder === 'none') return undefined;
  if (entry.erased.recorder === undefined)
    return store.stepOutput(run.id, entry.name);
  const output = await entry.erased.recorder.load(run.id);
  if (output === undefined)
    throw new RunPlanningError(
      `${run.jobKey}/${entry.name}: completed, but its recorder holds no output for run ${run.id}`,
    );
  return output;
}

/** A completed children step's output, read back from its slots and each done child's own output. */
export async function childrenOutputOf(
  store: JobStore,
  run: Run,
  name: string,
  erased: ErasedChildrenStep,
): Promise<unknown> {
  const out: ChildResults<unknown> = { results: [], failed: [], skipped: [] };
  for (const item of await store.items(run.id, name)) {
    const runId = item.ref;
    if (item.status === 'skipped') out.skipped.push({ key: item.key, runId });
    else if (item.status === 'failed')
      out.failed.push({
        key: item.key,
        runId,
        errorType: item.errorType ?? 'Error',
      });
    else if (item.status === 'done' || item.status === 'cached') {
      const childRun = await store.getRun(runId);
      out.results.push({
        key: item.key,
        runId,
        output: erased.job.output.parse(
          await runOutputOf(store, erased.job, childRun),
        ),
      });
    } else
      throw new RunPlanningError(
        `${run.jobKey}/${name}: completed with a pending child ${item.key}`,
      );
  }
  if (!erased.single) return out;
  const only = out.results[0];
  if (!only)
    throw new RunPlanningError(
      `${run.jobKey}/${name}: completed with no child output`,
    );
  return only.output;
}

/** What a step reads: the run's input and ids, and the outputs of every step before `index`. */
export async function contextFor(
  store: JobStore,
  job: AnyJob,
  run: Run,
  index: number,
  signal: AbortSignal,
): Promise<ErasedContext> {
  const states = new Map(
    (await store.stepStates(run.id)).map((s) => [s.name, s]),
  );
  const ctx: Record<string, unknown> = {
    input: await inputOf(store, job, run),
    tenantId: run.tenantId,
    runId: run.id,
    dryRun: run.dryRun,
    signal,
    outputOf: outputReader(store, run.tenantId),
  };
  for (const entry of job.steps.slice(0, index)) {
    const state = states.get(entry.name);
    if (state?.status !== 'completed' && state?.status !== 'skipped')
      throw new RunPlanningError(
        `${run.jobKey}/${job.steps[index]?.name}: step ${entry.name} before it has not completed`,
      );
    ctx[entry.name] = await stepOutputOf(store, run, entry, state);
  }
  return ctx as ErasedContext;
}

/** The map step a chunk belongs to. */
export function mapStepOf(
  job: AnyJob,
  name: string,
): { entry: StepEntry; erased: ErasedMapStep } {
  const entry = job.steps.find((s) => s.name === name);
  if (entry?.erased.kind !== 'map')
    throw new RunPlanningError(`${job.key}: no map step ${name}`);
  return { entry, erased: entry.erased };
}

/** The run's output: its last step's, once it completed. */
export async function runOutputOf(
  store: JobStore,
  job: AnyJob,
  run: Run,
): Promise<unknown> {
  const last = job.steps[job.steps.length - 1] as StepEntry;
  const state = (await store.stepStates(run.id)).find(
    (s) => s.name === last.name,
  );
  if (!state) throw new RunPlanningError(`${run.id}: no output yet`);
  return stepOutputOf(store, run, last, state);
}

/**
 * A completed run's output, read from where its last step's value lives (its recorder, or the store), parsed by the
 * job's output schema: what a caller shows for a run, never re-run. Undefined for a run that has not completed.
 */
export async function readRunOutput(
  deps: { store: JobStore; registry: Registry },
  run: Run,
): Promise<unknown> {
  if (run.status !== 'completed') return undefined;
  const job = deps.registry.get(run.jobKey);
  return job.output.parse(await runOutputOf(deps.store, job, run));
}

/**
 * `ctx.outputOf` (and `admit`'s): another run's output, typed by its job, for a reader in `tenantId`. It only
 * reads a completed run, whose output is written once and never changes, so a step that reads it stays a function of
 * its records. Each refusal is `InputRefusedError`, non-retryable, naming only the caller's own ids.
 */
export function outputReader(
  store: JobStore,
  tenantId: string,
): OutputOf {
  return async (job, runId) => {
    let run: Run;
    try {
      run = await store.getRun(runId);
    } catch (err) {
      if (err instanceof RunNotFoundError)
        throw new InputRefusedError(
          'run_not_found',
          `run ${runId} was not found`,
        );
      throw err;
    }
    // Another tenant's run reads exactly as a missing one: whether it exists is never revealed.
    if (run.tenantId !== tenantId)
      throw new InputRefusedError(
        'run_not_found',
        `run ${runId} was not found`,
      );
    if (run.jobKey !== job.key)
      throw new InputRefusedError(
        'run_wrong_job',
        `run ${runId} is not a run of ${job.key}`,
      );
    if (run.status !== 'completed')
      throw new InputRefusedError(
        'run_not_completed',
        `run ${runId} has not completed`,
      );
    let raw: unknown;
    try {
      raw = await runOutputOf(store, job, run);
    } catch (err) {
      if (!(err instanceof RunPlanningError)) throw err;
      raw = undefined;
    }
    const parsed = job.output.safeParse(raw);
    if (!parsed.success)
      throw new InputRefusedError(
        'run_output_unreadable',
        `run ${runId}'s output no longer matches ${job.key}'s output`,
      );
    return parsed.data;
  };
}
