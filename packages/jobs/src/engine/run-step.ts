import type { StepEntry } from '../define/define-job.ts';
import type { ErasedContext, ErasedPlainStep } from '../define/step.ts';
import {
  DEFAULT_THROTTLE_MS,
  errorTypeOf,
  GateClosedError,
  JobDefinitionError,
  throttleOf,
} from '../model/errors.ts';
import type { Run } from '../model/run.ts';
import { zeroCounts } from '../model/step-state.ts';
import {
  attemptsLeft,
  classifyError,
  computeBackoff,
  DEFAULT_RETRY,
} from '../policy/retry.ts';
import type { Permit } from '../ports/limiter.ts';
import type { AdvanceDeps } from './deps.ts';
import { eventBase } from './emitter.ts';
import { acquireAll } from './limits.ts';
import { assertStorable } from './values.ts';

export type PlainStepOutcome =
  | { kind: 'completed'; output: unknown }
  | { kind: 'failed'; error: unknown }
  | { kind: 'aborted' }
  /** The run left running (a cancel or a pause): the step stops where it is, and a resume runs it again. */
  | { kind: 'left' }
  /** It threw `GateClosedError`: the step parks on that gate, never fails. */
  | { kind: 'gateClosed'; gate: string; attempt: number };

/**
 * One run of a plain step's code under its limiters, held for the whole call and released however it ends. A throttle
 * (a 429) is never a failed attempt: its Retry-After is waited out (by the limiter, when the step has one) and the
 * code runs again in the same attempt.
 */
async function runThrottled(
  deps: AdvanceDeps,
  run: Run,
  entry: StepEntry & { erased: ErasedPlainStep },
  ctx: ErasedContext,
): Promise<unknown> {
  const { signal, clock } = deps;
  const { limiters } = entry.erased;
  for (;;) {
    const permit: Permit | null = limiters.length
      ? await acquireAll(
          deps.limiters,
          limiters,
          run.tenantId,
          { tokens: 0 },
          signal,
        )
      : null;
    try {
      const output = await entry.erased.run(ctx);
      await permit?.release();
      return output;
    } catch (err) {
      const throttle = throttleOf(err);
      await permit?.release(
        throttle
          ? { throttled: true, retryAfterMs: throttle.retryAfterMs }
          : {},
      );
      if (!throttle || signal.aborted) throw err;
      if (!permit)
        await clock.sleep(throttle.retryAfterMs ?? DEFAULT_THROTTLE_MS, signal);
    }
  }
}

/** Records a plain step completed, its output where it lives: nowhere ('none'), its recorder, or the store. */
async function recordOutput(
  store: AdvanceDeps['store'],
  run: Run,
  entry: StepEntry & { erased: ErasedPlainStep },
  output: unknown,
): Promise<void> {
  const { recorder } = entry.erased;
  if (recorder === 'none') {
    if (output !== undefined)
      throw new JobDefinitionError(
        `${run.jobKey}/${entry.name}: its output is 'none', and it returned a value`,
      );
    await store.recordStep(run.id, entry.name, { status: 'completed' });
    return;
  }
  if (recorder) {
    await recorder.save(run.id, output);
    await store.recordStep(run.id, entry.name, { status: 'completed' });
    return;
  }
  assertStorable(output, `${run.jobKey}/${entry.name}: its output`);
  await store.recordStep(run.id, entry.name, { status: 'completed', output });
}

/**
 * Runs a plain step: start (an attempt), run, record, then the next step may read it. A transient failure retries
 * after backoff; a crash mid-step spends its attempt too, so a step that keeps killing its worker still ends.
 */
export async function runPlainStep(
  deps: AdvanceDeps,
  run: Run,
  entry: StepEntry & { erased: ErasedPlainStep },
  ctx: ErasedContext,
): Promise<PlainStepOutcome> {
  const { store, clock, events, signal } = deps;
  const retry = entry.erased.retry ?? DEFAULT_RETRY;
  // The attempts the step is at now (a crashed advance's attempt included); each start is a CAS on them.
  let attempts =
    (await store.stepStates(run.id)).find((s) => s.name === entry.name)
      ?.attempts ?? 0;
  for (;;) {
    // Re-read before every attempt, the first included: a cancel or a pause stops the step's retries.
    if ((await store.getRun(run.id)).status !== 'running')
      return { kind: 'left' };
    const state = await store.startStep(
      run.id,
      { name: entry.name, index: entry.index, kind: 'step' },
      { attempts },
    );
    // Another advance started this attempt (or ended the step): it runs it, and this one leaves.
    if (!state) return { kind: 'left' };
    const attempt = state.attempts;
    attempts = attempt;
    const base = { ...eventBase(run, clock), step: entry.name, attempt };
    if (!attemptsLeft(retry, attempt - 1)) {
      const error = {
        type: 'AttemptsExhausted',
        message: `${entry.name}: attempts exhausted`,
      };
      await store.failStep(run.id, entry.name, error);
      await events.emit({
        ...base,
        type: 'step.failed',
        errorType: error.type,
      });
      return {
        kind: 'failed',
        error: Object.assign(new Error(error.message), { name: error.type }),
      };
    }
    await events.emit({ ...base, type: 'step.started' });
    try {
      const output = await runThrottled(deps, run, entry, ctx);
      if (signal.aborted) return { kind: 'aborted' };
      await recordOutput(deps.store, run, entry, output);
      await events.emit({
        ...base,
        type: 'step.completed',
        counts: zeroCounts(),
        speculation: null,
      });
      return { kind: 'completed', output };
    } catch (err) {
      const after = await afterFailure(deps, run, entry, base, err);
      if (after !== 'retry') return after;
    }
  }
}

/** The attempt's event fields, stamped when it started: its retried and failed events carry the attempt's start. */
type AttemptEventBase = ReturnType<typeof eventBase> & {
  step: string;
  attempt: number;
};

/**
 * A failed attempt: an abort or a closed gate leaves the step; a retryable error waits out its backoff
 * (`step.retried`) and the step runs again; anything else fails it (`step.failed`).
 */
async function afterFailure(
  deps: AdvanceDeps,
  run: Run,
  entry: StepEntry & { erased: ErasedPlainStep },
  base: AttemptEventBase,
  err: unknown,
): Promise<PlainStepOutcome | 'retry'> {
  const { store, clock, events, signal } = deps;
  const retry = entry.erased.retry ?? DEFAULT_RETRY;
  const { attempt } = base;
  if (signal.aborted) return { kind: 'aborted' };
  if (err instanceof GateClosedError)
    return { kind: 'gateClosed', gate: err.gate, attempt };
  if (classifyError(err, retry, attempt - 1) === 'retry') {
    await events.emit({
      ...base,
      type: 'step.retried',
      errorType: errorTypeOf(err),
      chunk: null,
    });
    try {
      await clock.sleep(computeBackoff(retry, attempt), signal);
    } catch {
      return { kind: 'aborted' };
    }
    return 'retry';
  }
  await store.failStep(run.id, entry.name, {
    type: errorTypeOf(err),
    message: err instanceof Error ? err.message : String(err),
  });
  await events.emit({
    ...base,
    type: 'step.failed',
    errorType: errorTypeOf(err),
  });
  return { kind: 'failed', error: err };
}
