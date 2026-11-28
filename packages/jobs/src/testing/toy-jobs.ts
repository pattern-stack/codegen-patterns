import { z } from 'zod';
import {
  memoryRecorder,
  memoryResultRecorder,
} from '../adapters/memory-recorder.ts';
import { defineJob } from '../define/define-job.ts';
import { mapStep } from '../define/map-step.ts';
import { step } from '../define/step.ts';
import { NonRetryableError } from '../model/errors.ts';
import type { RetryPolicy } from '../policy/retry.ts';
import type { StopPredicate } from '../policy/stop.ts';
import type { StepRecorder } from '../ports/step-recorder.ts';

/** n ids, `o000` … in order. */
export const ids = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `o${String(i).padStart(3, '0')}`);

/** A toy item's score: a pure function of its id, so any run of any width gets the same one. */
export const scoreOf = (ref: string): number =>
  ((Number(ref.slice(1)) * 37) % 100) / 100;

/** What a toy job's batch was asked: one entry per call. */
export interface ToyCall {
  step: string;
  refs: string[];
}

export interface ToyOptions {
  /** Refs whose batch always throws a `NonRetryableError`: each fails alone after the split. */
  bad?: readonly string[];
  /** The first n batch calls throw a transient error. */
  transientCalls?: number;
  batchMax?: number;
  limiter?: string;
  retry?: RetryPolicy;
  /** Where the `list` step's output goes; default the store. */
  recorder?: StepRecorder<string[]>;
  /** Every value in a memory recorder (the input, each output, the results): a store that keeps none can run it. */
  recorded?: boolean;
  /** A per-call hook: return a promise to hold the call (as a crash leaves one), or nothing to answer. */
  onCall?: (
    n: number,
    call: ToyCall,
    signal: AbortSignal,
  ) => Promise<void> | undefined;
}

export const ToyInput = z.object({ n: z.number().int().min(0) });
export const ToyOutput = z.object({
  count: z.number(),
  failed: z.number(),
  total: z.number(),
});

type ToySummary = z.infer<typeof ToyOutput> & { listed: number };

/** Text a hydrated toy item carries, so a test can check none of it reaches an event. */
export const TOY_CONTENT = 'private toy content';

function toy(
  key: string,
  options: ToyOptions,
  stopWhen?: StopPredicate<number>,
) {
  const calls: ToyCall[] = [];
  const bad = new Set(options.bad ?? []);
  const recorders = options.recorded
    ? {
        input: memoryRecorder<z.infer<typeof ToyInput>>(),
        list: memoryRecorder<string[]>(),
        score: memoryResultRecorder<number>(),
        summary: memoryRecorder<ToySummary>(),
      }
    : null;
  const job = defineJob({
    key,
    input: ToyInput,
    output: ToyOutput,
    inputRecorder: recorders?.input,
    steps: (s) =>
      s
        .add(
          'list',
          step({
            run: ({ input }) => ids(input.n),
            recorder: recorders?.list ?? options.recorder,
          }),
        )
        .add(
          'score',
          mapStep({
            items: ({ list }) => list,
            key: (ref) => `m1:${ref}`,
            hydrate: async (refs) =>
              refs.map((ref) => ({ ref, text: `${TOY_CONTENT} ${ref}` })),
            run: async (batch, { signal }) => {
              const call = { step: 'score', refs: batch.map((b) => b.ref) };
              calls.push(call);
              await options.onCall?.(calls.length, call, signal);
              if (calls.length <= (options.transientCalls ?? 0))
                throw new Error('503 from the toy provider');
              if (batch.some((b) => bad.has(b.ref)))
                throw new NonRetryableError('the toy provider refuses it');
              return batch.map((b) => scoreOf(b.item.ref));
            },
            result: z.number(),
            results: recorders?.score,
            batch: { max: options.batchMax ?? 2 },
            limiter: options.limiter ?? 'toy',
            retry: options.retry,
            stopWhen,
          }),
        )
        .add(
          'summary',
          step({
            recorder: recorders?.summary,
            run: ({ score, list }): ToySummary => ({
              count: score.results.length,
              failed: score.failed.length,
              total: Math.round(
                score.results.reduce((a, r) => a + r.result, 0) * 100,
              ),
              listed: list.length,
            }),
          }),
        ),
  });
  return { job, calls, recorders };
}

/** list → score (a map step over the list) → summary. */
export const toyScoring = (options: ToyOptions = {}) =>
  toy('toy.scoring', options);

const low = (o: { ok: boolean; result?: number }) =>
  o.ok && (o.result ?? 1) < 0.2;

/** As `toyScoring`, with an ordered early stop: at the third item scoring under 0.2 (o011, the 12th item). */
export const toyStopping = (options: ToyOptions = {}) =>
  toy(
    'toy.stopping',
    options,
    (o, _i, before) => low(o) && before.filter(low).length === 2,
  );

/** A call that holds until its signal aborts, as a crash leaves one. */
export const hang = (signal: AbortSignal): Promise<void> =>
  new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });
