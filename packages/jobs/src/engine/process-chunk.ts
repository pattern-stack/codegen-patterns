import { firstClosed } from '../define/gate.ts';
import type {
  BatchResult,
  ErasedContext,
  ErasedMapStep,
} from '../define/step.ts';
import type { ChunkClaim, SettleOutcome } from '../model/chunk.ts';
import {
  ClaimLostError,
  errorTypeOf,
  GateClosedError,
  JobDefinitionError,
  throttleOf,
} from '../model/errors.ts';
import type { Keyed } from '../model/item.ts';
import type { Run, RunError, Spend } from '../model/run.ts';
import { spendOf, spendOfError } from '../model/spent.ts';
import {
  attemptsLeft,
  classifyError,
  computeBackoff,
  DEFAULT_RETRY,
  isNonRetryable,
  type RetryPolicy,
} from '../policy/retry.ts';
import type { Permit } from '../ports/limiter.ts';
import { packBatches } from './batches.ts';
import { contextFor, mapStepOf } from './context.ts';
import type { ChunkDeps } from './deps.ts';
import { eventBase } from './emitter.ts';
import { acquireAll } from './limits.ts';
import { applyStop, stopFound } from './run-map-step.ts';
import { cachedKeys, writeDone } from './values.ts';
import { parkOnGate } from './waits.ts';

/** How a chunk left `processChunk`. `lost` and `aborted` left it unsettled: its claim expires, or was taken. */
export type ChunkOutcome =
  | 'completed'
  | 'retry'
  | 'failed'
  | 'yielded'
  | 'lost'
  | 'aborted';

const asRunError = (err: unknown): RunError => ({
  type: errorTypeOf(err),
  message: err instanceof Error ? err.message : String(err),
});

const ZERO: Spend = { calls: 0, inputTokens: 0, costUsd: 0 };

/** A batch's `failed`, by index; a malformed one (out of range, twice, no type) is a definition error. */
function failedIndexes(
  failed: readonly { index: number; errorType: string }[] | undefined,
  size: number,
): Map<number, string> {
  const out = new Map<number, string>();
  for (const f of failed ?? []) {
    if (
      !Number.isInteger(f.index) ||
      f.index < 0 ||
      f.index >= size ||
      out.has(f.index) ||
      !f.errorType
    )
      throw new JobDefinitionError(
        `a batch of ${size} named a failed item it doesn't hold (index ${f.index}, once each, with an error type)`,
      );
    out.set(f.index, f.errorType);
  }
  return out;
}

/** An item whose answer its step's result schema refused: it fails alone. */
export const RESULT_SCHEMA_ERROR = 'ResultSchemaError';

/** A batch on its way: its items, its estimated cost, and the limiter slot it holds. */
interface Asked {
  batch: readonly Keyed<unknown>[];
  cost: { tokens: number; usd: number };
  permit: Permit;
}

/** A batch's answer once written: the items it refused, and the input tokens it spent. */
interface Landed {
  refused: { key: string; errorType: string }[];
  inputTokens: number;
}

/** A batch's items, sorted: an answer its schema refuses, or one the batch named failed, fails that item alone. */
function sortResults(
  step: ErasedMapStep,
  batch: readonly Keyed<unknown>[],
  out: BatchResult<unknown>,
): {
  done: { key: string; ref: string; result: unknown }[];
  refused: { key: string; errorType: string }[];
} {
  const failedAt = failedIndexes(out.failed, batch.length);
  const done: { key: string; ref: string; result: unknown }[] = [];
  const refused: { key: string; errorType: string }[] = [];
  batch.forEach((b, i) => {
    const failedType = failedAt.get(i);
    if (failedType !== undefined) {
      refused.push({ key: b.key, errorType: failedType });
      return;
    }
    const raw = out.results[i];
    if (step.results === 'none') {
      done.push({ key: b.key, ref: b.ref, result: raw });
      return;
    }
    try {
      done.push({ key: b.key, ref: b.ref, result: step.parse(raw) });
    } catch {
      refused.push({ key: b.key, errorType: RESULT_SCHEMA_ERROR });
    }
  });
  return { done, refused };
}

interface ChunkRun {
  deps: ChunkDeps;
  claim: ChunkClaim;
  run: Run;
  step: ErasedMapStep;
  ctx: ErasedContext;
  retry: RetryPolicy;
}

/**
 * The batches of one chunk's uncached items, asked concurrently on the step's limiter and recorded as each lands. A
 * throttle (a 429) asks the same batch again once its Retry-After has passed, spending no attempt; a transient failure
 * leaves its items pending (the chunk retries after backoff); a non-retryable one splits the batch in halves until
 * the bad item is alone, and it alone fails. A spent budget stops issuing calls (the run paused), and so does the
 * step's early stop, read after each batch lands.
 */
async function runBatches(
  c: ChunkRun,
  items: readonly Keyed<unknown>[],
): Promise<'stopped' | 'asked'> {
  const { deps, claim, run, step, ctx, retry } = c;
  const { store, signal, events, clock } = deps;
  let transient: unknown = null;
  let fatal: unknown = null;
  // A batch that found its step's gate closed: the chunk's other calls finish and write, then it yields and parks.
  let closedGate: string | null = null;
  // The step's early stop, read after each batch lands: once found, no batch is issued, and those in flight land and
  // are recorded (the step's speculation).
  let stopped = false;
  // The first error that ends the chunk's asking: thrown once every batch in flight has landed.
  const recordFatal = (err: unknown) => {
    fatal ??= err;
  };
  const readStop = async () => {
    if (stopped || !step.stopWhen) return;
    try {
      if (await stopFound(store, run, claim.step, step, deps.stops))
        stopped = true;
    } catch (err) {
      recordFatal(err);
    }
  };

  const progress = async () => {
    const state = (await store.stepStates(run.id)).find(
      (s) => s.name === claim.step,
    );
    if (state)
      await events.emit({
        ...eventBase(run, clock),
        type: 'step.progress',
        step: claim.step,
        attempt: state.attempts,
        counts: state.counts,
      });
  };

  // One provider call. A call that paid and then threw (`withSpend`) has its spend recorded here, unfenced, before the
  // error goes on to its retry, split or failure: each call's spend is recorded exactly once, by its write or by this.
  const callOnce = async (batch: readonly Keyed<unknown>[]) => {
    try {
      return await step.run(batch, ctx);
    } catch (err) {
      const spent = spendOfError(err);
      if (spent) await store.addSpend(claim, spent);
      throw err;
    }
  };

  const itemFailed = (key: string, errorType: string) =>
    events.emit({
      ...eventBase(run, clock),
      type: 'item.failed',
      step: claim.step,
      attempt: claim.attempts,
      key,
      errorType,
    });

  // The call takes its slot on the limiter first, then reserves: a reservation covers a call in flight, never one
  // still queued behind the limiter. Null when the batch is not issued: a failure, the stop, or a spent budget.
  const takeSlot = async (cost: { tokens: number; usd: number }) => {
    let permit: Permit;
    try {
      permit = await acquireAll(
        deps.limiters,
        step.limiters,
        run.tenantId,
        { tokens: cost.tokens },
        signal,
      );
    } catch (err) {
      recordFatal(err);
      return null;
    }
    // The stop was found while this batch waited for its slot: it is never issued.
    if (stopped) {
      await permit.release();
      return null;
    }
    let reservation: Awaited<ReturnType<typeof store.reserve>>;
    try {
      reservation = await store.reserve(claim, cost.usd);
    } catch (err) {
      permit.release();
      recordFatal(err);
      return null;
    }
    if (reservation === 'ok') return permit;
    permit.release();
    if (reservation === 'paused') {
      const paused = await store.getRun(run.id);
      await events.emit({
        ...eventBase(paused, clock),
        type: 'run.paused',
        reason: paused.pauseReason ?? 'budget',
      });
    }
    return null;
  };

  // A batch's answer, written: its results, each checked on its own. The write settles the reservation by its
  // estimate, so once this returns the reservation is gone; what it refused is left for `afterLanding`.
  const land = async (
    asked: Asked,
    out: BatchResult<unknown>,
  ): Promise<Landed> => {
    const { batch, cost } = asked;
    const spend = spendOf(out.spend);
    if (out.results.length !== batch.length)
      throw new JobDefinitionError(
        `${run.jobKey}/${claim.step}: a batch of ${batch.length} returned ${out.results.length} results`,
      );
    const { done, refused } = sortResults(step, batch, out);
    await writeDone(store, claim, run, step, done, spend, cost.usd);
    return { refused, inputTokens: spend.inputTokens };
  };

  // After the write: the refused items failed, the progress, then the stop read.
  const afterLanding = async (asked: Asked, landed: Landed): Promise<void> => {
    if (landed.refused.length) {
      await store.writeResults(claim, { failed: landed.refused }, ZERO);
      for (const r of landed.refused) await itemFailed(r.key, r.errorType);
    }
    await progress();
    // The slot is held until the batch wrote and read the stop, so every batch that starts was cleared by an
    // earlier read: once the stop trips, at most the limiter's width of batches is past it.
    await readStop();
    await asked.permit.release({
      tokens: landed.inputTokens || asked.cost.tokens,
    });
  };

  // A non-retryable failure of one item: it alone fails.
  const failAlone = async (only: Keyed<unknown>, err: unknown) => {
    const errorType = errorTypeOf(err);
    try {
      await store.writeResults(
        claim,
        { failed: [{ key: only.key, errorType }] },
        ZERO,
      );
    } catch (e) {
      recordFatal(e);
      return;
    }
    await itemFailed(only.key, errorType);
    await readStop();
  };

  // After a batch failed (its reservation released, its permit back): what the failure means for the chunk.
  const afterFailure = async (
    batch: readonly Keyed<unknown>[],
    err: unknown,
    throttled: boolean,
  ): Promise<void> => {
    if (
      err instanceof ClaimLostError ||
      err instanceof JobDefinitionError ||
      signal.aborted
    ) {
      recordFatal(err);
      return;
    }
    // A throttle is never a failed attempt: the step's limiter (a map step always has one) waits out its
    // Retry-After, and the same batch is asked again.
    if (throttled) return ask(batch);
    // Never a failure: the items stay pending, no attempt spent, and the step parks on the gate.
    if (err instanceof GateClosedError) {
      closedGate ??= err.gate;
      return;
    }
    if (!isNonRetryable(err, retry)) {
      transient ??= err;
      return;
    }
    const [only] = batch;
    if (batch.length === 1 && only) return failAlone(only, err);
    const half = Math.ceil(batch.length / 2);
    await Promise.all([ask(batch.slice(0, half)), ask(batch.slice(half))]);
  };

  const ask = async (batch: readonly Keyed<unknown>[]): Promise<void> => {
    if (signal.aborted || fatal || closedGate || stopped) return;
    const cost = step.cost(batch);
    const permit = await takeSlot(cost);
    if (!permit) return;
    const asked: Asked = { batch, cost, permit };
    // The reservation is settled by its estimate exactly once: by the call's write, or released when the call fails.
    let landed: Landed | null = null;
    try {
      landed = await land(asked, await callOnce(batch));
      await afterLanding(asked, landed);
    } catch (err) {
      if (!landed)
        await store.releaseReservation(claim, cost.usd).catch(recordFatal);
      const throttle = throttleOf(err);
      // A 429's block is in the limiter before this batch asks again.
      await permit.release(
        throttle
          ? { throttled: true, retryAfterMs: throttle.retryAfterMs }
          : {},
      );
      await afterFailure(batch, err, throttle !== null);
    }
  };

  await Promise.all(packBatches(items, step.batchMax).map(ask));
  if (fatal) throw fatal;
  signal.throwIfAborted();
  // Every item left is past the stop (the stop reads a settled prefix): a closed gate or a transient failure among
  // them no longer matters.
  if (stopped) return 'stopped';
  if (closedGate) throw new GateClosedError(closedGate);
  if (transient) throw transient;
  return 'asked';
}

/** The chunk's pending items: cached keys answered, the rest hydrated and asked. True once the step's stop is found. */
async function askPending(c: ChunkRun, jobKey: string): Promise<boolean> {
  const { deps, claim, run, step, ctx } = c;
  const { store } = deps;
  let pending = await store.pendingItems(claim);
  if (!pending.length) return false;
  const hits = await cachedKeys(
    store,
    run,
    claim.step,
    step,
    pending.map((i) => i.key),
  );
  if (hits.size) {
    await store.writeResults(claim, { cached: [...hits] }, ZERO);
    pending = pending.filter((i) => !hits.has(i.key));
  }
  if (!pending.length) return false;
  const hydrated = await step.hydrate(
    pending.map((i) => i.ref),
    ctx,
  );
  if (hydrated.length !== pending.length)
    throw new JobDefinitionError(
      `${jobKey}/${claim.step}: hydrate returned ${hydrated.length} items for ${pending.length} refs`,
    );
  const items = pending.map((i, n) => ({
    key: i.key,
    ref: i.ref,
    item: hydrated[n],
  }));
  return (await runBatches(c, items)) === 'stopped';
}

/**
 * The one function every executor calls per claimed chunk. It reads the chunk's pending items, answers cached keys,
 * hydrates and asks the rest in batches, and settles the chunk: completed once every item is settled, else a retry
 * after backoff, failed once its attempts run out. Every write is fenced by the claim.
 */
export async function processChunk(
  deps: ChunkDeps,
  claim: ChunkClaim,
): Promise<ChunkOutcome> {
  const { store, signal, clock, events } = deps;
  const run = await store.getRun(claim.runId);
  const job = deps.registry.get(run.jobKey);
  if (job.version !== run.jobVersion)
    throw new JobDefinitionError(
      `${job.key}: run ${run.id} was made by version ${run.jobVersion}; this process has ${job.version}`,
    );
  const { entry, erased: step } = mapStepOf(job, claim.step);
  const retry = step.retry ?? DEFAULT_RETRY;

  const failPending = async (error: RunError) => {
    const left = await store.pendingItems(claim);
    const outcome = await settle({ kind: 'failed', error });
    if (outcome === 'failed')
      for (const item of left)
        await events.emit({
          ...eventBase(run, clock),
          type: 'item.failed',
          step: claim.step,
          attempt: claim.attempts,
          key: item.key,
          errorType: error.type,
        });
    return outcome;
  };
  const settle = async (outcome: SettleOutcome): Promise<ChunkOutcome> => {
    try {
      await store.releaseChunk(claim, outcome);
    } catch (err) {
      if (err instanceof ClaimLostError) return 'lost';
      throw err;
    }
    // A settled chunk may complete the stop's prefix: stop the step now, before this worker takes another chunk,
    // so a narrow executor never works past it.
    if (outcome.kind === 'completed' || outcome.kind === 'failed')
      await applyStop(store, run, claim.step, step, deps.stops);
    return outcome.kind === 'yield' ? 'yielded' : outcome.kind;
  };

  // Crashes count as attempts too (the claim spends one), so a chunk that keeps killing its worker still ends.
  if (!attemptsLeft(retry, claim.attempts - 1))
    return failPending({
      type: 'AttemptsExhausted',
      message: 'attempts exhausted',
    });

  // A closed gate parks the step and gives the chunk back (no attempt spent): the run carries on once it opens.
  const parkOn = async (name: string): Promise<ChunkOutcome> => {
    const gate = step.gates.find((g) => g.name === name);
    if (!gate)
      return failPending(
        asRunError(
          new JobDefinitionError(
            `${job.key}/${claim.step}: a batch threw GateClosedError for ${name}, a gate its step doesn't declare`,
          ),
        ),
      );
    await parkOnGate(deps, run, entry, gate, claim.attempts);
    return settle({ kind: 'yield' });
  };

  let failure: unknown = null;
  let stepStopped = false;
  try {
    const ctx = await contextFor(store, job, run, entry.index, signal);
    if (step.gates.length) {
      const closed = await firstClosed(step.gates, ctx);
      if (closed) return parkOn(closed.name);
    }
    stepStopped = await askPending(
      { deps, claim, run, step, ctx, retry },
      job.key,
    );
  } catch (err) {
    if (err instanceof ClaimLostError) return 'lost';
    if (err instanceof GateClosedError && !signal.aborted)
      return parkOn(err.gate);
    failure = err;
  }
  const stopped = (status: string) =>
    status === 'paused' || status === 'waiting';
  if (signal.aborted) {
    // A pause or a park under the chunk gives it back without spending an attempt; a cancel, a lost claim or a crash
    // leaves it to the store and the sweeper.
    const current = await store.getRun(claim.runId);
    return stopped(current.status) ? settle({ kind: 'yield' }) : 'aborted';
  }
  const left = await store.pendingItems(claim);
  // A stopped chunk is done: settling it applies the stop, which skips what it left pending.
  if (!left.length || stepStopped) return settle({ kind: 'completed' });
  const current = await store.getRun(claim.runId);
  if (stopped(current.status)) return settle({ kind: 'yield' });
  const error = failure
    ? asRunError(failure)
    : { type: 'Unsettled', message: `${left.length} items left unsettled` };
  if (classifyError(failure ?? error, retry, claim.attempts - 1) === 'fail')
    return failPending(error);
  await events.emit({
    ...eventBase(run, clock),
    type: 'step.retried',
    step: claim.step,
    attempt: claim.attempts,
    errorType: error.type,
    chunk: claim.index,
  });
  return settle({
    kind: 'retry',
    at: new Date(clock.now().getTime() + computeBackoff(retry, claim.attempts)),
    error,
  });
}
