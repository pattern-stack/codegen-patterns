import type { AnyJob } from '../define/define-job.ts';
import type { ErasedMapStep } from '../define/step.ts';
import type { ChunkClaim } from '../model/chunk.ts';
import { JobDefinitionError, RunPlanningError } from '../model/errors.ts';
import { type Done, resultScope } from '../model/item.ts';
import type { Run, Spend } from '../model/run.ts';
import type { JobStore } from '../ports/job-store.ts';

/**
 * Where a job's values live. Each value (the run's input, a step's output, a map step's item results) lives in the
 * store, as plain JSON, unless its definition names a recorder (a domain's own tables). A void value may opt out
 * ('none'). Nothing is dropped silently: a store that keeps no values refuses a job with a value that has no
 * recorder, a value handed to 'none' is a definition error, and a value the store can't hold as JSON is refused
 * before it is written, never turned into something else.
 */

/** The most one stored value may take as JSON: a step returns a small value or a reference (Temporal caps a payload at about 2 MB). */
export const MAX_STORED_VALUE_BYTES = 1_000_000;

/** The first part of a value plain JSON can't carry as it is, as a path and a reason; null when it is plain JSON. */
export function nonJsonPart(value: unknown, path = '$'): string | null {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return null;
    case 'number':
      return Number.isFinite(value)
        ? null
        : `${path}: ${value} is not a finite number`;
    case 'object':
      return Array.isArray(value)
        ? nonJsonArrayPart(value, path)
        : nonJsonObjectPart(value, path);
    default:
      return `${path}: a ${typeof value}`;
  }
}

function nonJsonArrayPart(value: unknown[], path: string): string | null {
  for (let i = 0; i < value.length; i++) {
    if (!(i in value) || value[i] === undefined)
      return `${path}[${i}]: undefined in an array`;
    const bad = nonJsonPart(value[i], `${path}[${i}]`);
    if (bad) return bad;
  }
  return null;
}

function nonJsonObjectPart(value: object, path: string): string | null {
  // A plain object's prototype is null or an Object.prototype, of any realm: a value read back from a store that
  // clones or parses in another realm (Jest's VM, a worker) is still plain. Anything else is an instance.
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && Object.getPrototypeOf(proto) !== null)
    return `${path}: a ${proto?.constructor?.name ?? 'class'} instance, not a plain object`;
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const bad = nonJsonPart(v, `${path}.${k}`);
    if (bad) return bad;
  }
  return null;
}

/**
 * Refuses a value a store can't keep as it is: not plain JSON (a Date, a Map, a bigint, a class instance, a NaN), or
 * over `MAX_STORED_VALUE_BYTES` (thrown as `tooLarge`: a run input's size is the request's to fix). A Date would come
 * back from a JSON column as a string, so it is refused here, on every store, rather than changed on one.
 */
export function assertStorable(
  value: unknown,
  what: string,
  tooLarge: new (message: string) => Error = JobDefinitionError,
): void {
  if (value === undefined) return;
  const bad = nonJsonPart(value);
  if (bad)
    throw new JobDefinitionError(
      `${what} is not plain JSON (${bad}): return ids, strings and numbers, or name a recorder`,
    );
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes > MAX_STORED_VALUE_BYTES)
    throw new tooLarge(
      `${what} is ${bytes} bytes as JSON, over ${MAX_STORED_VALUE_BYTES}: return a reference, and keep bulk data where it belongs`,
    );
}

/** The values of a job that only a store keeping values could hold. */
export function valuesWithoutRecorders(job: AnyJob): string[] {
  const out: string[] = [];
  if (job.inputRecorder === undefined) out.push('its input');
  for (const { name, erased } of job.steps)
    if (erased.kind === 'wait') out.push(`step ${name}'s signal value`);
    else if (erased.kind === 'children')
      out.push(`children step ${name}'s child inputs`);
    else if (
      erased.kind === 'step'
        ? erased.recorder === undefined
        : erased.results === undefined
    )
      out.push(
        erased.kind === 'step'
          ? `step ${name}'s output`
          : `map step ${name}'s results`,
      );
  return out;
}

/** Refuses a job a store cannot hold every value of. */
export function assertStoreHoldsValues(job: AnyJob, store: JobStore): void {
  if (store.keepsValues) return;
  const missing = valuesWithoutRecorders(job);
  if (missing.length)
    throw new JobDefinitionError(
      `${job.key}: this store keeps no values, and ${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} no recorder`,
    );
}

/**
 * Refuses a job with a side-effecting step on a store that can lose acknowledged writes, before any run is made, so
 * no refused run holds a dedupe key. Every executor's submit applies it too.
 */
export function assertStoreSafeFor(job: AnyJob, store: JobStore): void {
  if (
    job.steps.some((s) => s.erased.effect === 'side-effect') &&
    store.durability !== 'durable'
  )
    throw new JobDefinitionError(
      `${job.key} has side effects: it needs a store that can't lose acknowledged writes`,
    );
}

/**
 * The value the store keeps for the run's input: none when a recorder holds it. An input over
 * `MAX_STORED_VALUE_BYTES` is the request's to fix, so it is refused as one (`RunPlanningError`, which every surface
 * answers as a refused input); one that isn't plain JSON after the job's schema parsed it is the definition's
 * (`JobDefinitionError`).
 */
export function inputForStore(job: AnyJob, input: unknown): unknown {
  if (job.inputRecorder !== undefined || input === undefined) return undefined;
  const what = `${job.key}: its input`;
  assertStorable(input, what, RunPlanningError);
  return input;
}

/**
 * Records a new run's input in its recorder. Only the request that created the run records it: a dedupe hit never
 * writes its own input into the run it found, so a run whose input was lost still fails as unrecorded.
 */
export async function recordInput(
  job: AnyJob,
  runId: string,
  input: unknown,
): Promise<void> {
  const recorder = job.inputRecorder;
  if (recorder === undefined || recorder === 'none') return;
  await recorder.save(runId, input);
}

/** A run's input, from where it lives. A recorded input that is missing fails the run; no step runs without it. */
export async function inputOf(
  store: JobStore,
  job: AnyJob,
  run: Run,
): Promise<unknown> {
  const recorder = job.inputRecorder;
  if (recorder === undefined) return store.runInput(run.id);
  if (recorder === 'none') return undefined;
  const input = await recorder.load(run.id);
  if (input === undefined)
    throw new RunPlanningError(`${job.key}: run ${run.id}: input not recorded`);
  return input;
}

/** Where the store keeps a map step's results: its `cacheScope`, else its own `<jobKey>/<step>`. */
export const cacheScopeOf = (
  run: Run,
  name: string,
  step: ErasedMapStep,
): string => step.cacheScope ?? resultScope(run.jobKey, name);

/** The stored results of a map step's keys, from where they live. 'none': each key's result is undefined. */
export async function resultsOf(
  store: JobStore,
  run: Run,
  name: string,
  step: ErasedMapStep,
  keys: string[],
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (!keys.length) return out;
  if (step.results === 'none') {
    for (const k of keys) out.set(k, undefined);
    return out;
  }
  const found =
    step.results === undefined
      ? await store.itemResults<unknown>(
          cacheScopeOf(run, name, step),
          run.tenantId,
          keys,
        )
      : await step.results.load(run.tenantId, keys);
  for (const [k, v] of found) out.set(k, v.result);
  return out;
}

/** The cache read: keys an earlier run of the same meaning answered. Void results are never cached; a refresh reads none. */
export async function cachedKeys(
  store: JobStore,
  run: Run,
  name: string,
  step: ErasedMapStep,
  keys: string[],
): Promise<Set<string>> {
  if (step.results === 'none' || run.cache === 'refresh') return new Set();
  return new Set((await resultsOf(store, run, name, step, keys)).keys());
}

/**
 * Writes a batch's results where they live, then marks the items in the store (fenced by the claim). A recorder is
 * written first: a crash between the two leaves the items pending with a result, which the next attempt reads as
 * cached instead of asking again.
 */
export async function writeDone(
  store: JobStore,
  claim: ChunkClaim,
  run: Run,
  step: ErasedMapStep,
  done: Required<Done<unknown>>[],
  spend: Spend,
  reservedUsd: number,
): Promise<void> {
  const reservation = { reservedUsd };
  if (step.results === undefined) {
    for (const d of done)
      assertStorable(
        d.result,
        `${run.jobKey}/${claim.step}: item ${d.key}'s result`,
      );
    await store.writeResults(
      claim,
      { done, scope: cacheScopeOf(run, claim.step, step) },
      spend,
      reservation,
    );
    return;
  }
  if (step.results === 'none') {
    if (done.some((d) => d.result !== undefined))
      throw new JobDefinitionError(
        `${run.jobKey}/${claim.step}: its results are 'none', and a batch returned a value`,
      );
  } else if (done.length)
    await step.results.save(run.tenantId, run.id, done);
  await store.writeResults(
    claim,
    { done: done.map(({ key, ref }) => ({ key, ref })) },
    spend,
    reservation,
  );
}
