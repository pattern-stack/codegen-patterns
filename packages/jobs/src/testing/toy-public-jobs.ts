import { z } from 'zod';
import {
  memoryRecorder,
  memoryResultRecorder,
} from '../adapters/memory-recorder.ts';
import {
  defineJob,
  InputRefusedError,
  type JobLimits,
  mapStep,
  step,
} from '../index.ts';
import type { StepRecorder } from '../ports.ts';

/** Toy jobs for the jobs API's tests: two public ones and an internal one, all on memory recorders. */

export const TOY_LIMITS: JobLimits = {
  maxItems: 10,
  maxUsd: 1,
  maxCalls: 5,
  maxDurationMs: 3_600_000,
};

const ToyInput = z.object({
  typeKey: z.string(),
  itemCount: z.number().int().min(0).max(10),
});
const ToyOutput = z.object({ seenKey: z.string(), scoredItems: z.number() });
type ToyOutputValue = z.infer<typeof ToyOutput>;

/** A public job: tenant-wide reads and dry runs, admin real runs; its `admit` refuses the type 'nope'. */
export function toyPublicDry(
  options: {
    key?: string;
    batchMax?: number;
    /** Where the last step's output lives; a memory recorder by default. */
    summaryRecorder?: StepRecorder<ToyOutputValue>;
  } = {},
) {
  return defineJob({
    key: options.key ?? 'toy.public-dry',
    audience: 'public',
    authority: { read: 'tenant-wide', dryRun: 'tenant-wide', start: 'admin' },
    limits: TOY_LIMITS,
    input: ToyInput,
    output: ToyOutput,
    inputRecorder: memoryRecorder<z.infer<typeof ToyInput>>(),
    admit: async (input) => {
      if (input.typeKey === 'nope')
        throw new InputRefusedError('type_unknown', 'No such type');
    },
    steps: (s) =>
      s
        .add(
          'items',
          step({
            run: ({ input }) =>
              Array.from({ length: input.itemCount }, (_, i) => `i${i}`),
            recorder: memoryRecorder<string[]>(),
          }),
        )
        .add(
          'score',
          mapStep({
            items: ({ items }) => items,
            key: (ref) => ref,
            run: async (batch) => batch.map(() => 1),
            results: memoryResultRecorder<number>(),
            batch: { max: options.batchMax ?? 2 },
            limiter: 'toy',
          }),
        )
        .add(
          'summary',
          step({
            run: ({ input, score }) => ({
              seenKey: input.typeKey,
              scoredItems: score.results.length,
            }),
            recorder:
              options.summaryRecorder ?? memoryRecorder<ToyOutputValue>(),
          }),
        ),
  });
}

/** A public job that only reads: a tenant key may start its real runs too. */
export function toyPublicReadOnly() {
  return defineJob({
    key: 'toy.public-read-only',
    audience: 'public',
    authority: { read: 'member', start: 'tenant-wide' },
    limits: TOY_LIMITS,
    input: z.object({ note: z.string().optional() }),
    output: z.object({ ok: z.boolean() }),
    inputRecorder: memoryRecorder<{ note?: string }>(),
    steps: (s) =>
      s.add(
        'only',
        step({ run: () => ({ ok: true }), recorder: memoryRecorder() }),
      ),
  });
}

/** An internal job: no public surface reaches it. */
export function toyInternal() {
  return defineJob({
    key: 'toy.internal',
    input: z.object({ n: z.number() }),
    output: z.number(),
    inputRecorder: memoryRecorder<{ n: number }>(),
    steps: (s) =>
      s.add(
        'only',
        step({
          run: ({ input }) => input.n,
          recorder: memoryRecorder<number>(),
        }),
      ),
  });
}

/**
 * A public job with a side-effecting step whose dry run is tenant-wide: the step publishes only when the run is not dry
 * (the review rule a job whose dry run sits below admin keeps). `published` records each real write.
 */
export function toyPublicPublishing() {
  const published: string[] = [];
  const job = defineJob({
    key: 'toy.public-publishing',
    audience: 'public',
    authority: { read: 'tenant-wide', dryRun: 'tenant-wide', start: 'admin' },
    limits: TOY_LIMITS,
    input: z.object({ typeKey: z.string() }),
    output: z.object({ published: z.boolean() }),
    inputRecorder: memoryRecorder<{ typeKey: string }>(),
    steps: (s) =>
      s.add(
        'publish',
        step({
          run: ({ input, runId, dryRun }) => {
            if (!dryRun) published.push(`${runId}:${input.typeKey}`);
            return { published: !dryRun };
          },
          recorder: memoryRecorder<{ published: boolean }>(),
          effect: 'side-effect',
        }),
      ),
  });
  return { job, published };
}
