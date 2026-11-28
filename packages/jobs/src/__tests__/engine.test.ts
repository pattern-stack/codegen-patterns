import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import {
  InProcessExecutor,
  runToCompletion,
} from '../adapters/in-process-executor.ts';
import { localLimiters } from '../adapters/local-limiter.ts';
import {
  memoryRecorder,
  memoryResultRecorder,
} from '../adapters/memory-recorder.ts';
import { MemoryJobStore } from '../adapters/memory-store.ts';
import { systemClock } from '../adapters/system-clock.ts';
import { defineJob, type JobOptions } from '../define/define-job.ts';
import { gate } from '../define/gate.ts';
import { mapStep } from '../define/map-step.ts';
import { createRegistry } from '../define/registry.ts';
import { type BatchResult, step, waitFor } from '../define/step.ts';
import { mapStepOf, settledPrefix } from '../engine/context.ts';
import {
  cancelRun,
  pauseRun,
  resumeRun,
  startRun,
} from '../engine/start-run.ts';
import { STOP_READ_FIRST, STOP_READ_MAX } from '../engine/stop-scan.ts';
import { MAX_STORED_VALUE_BYTES, nonJsonPart } from '../engine/values.ts';
import { openGate } from '../engine/waits.ts';
import {
  GateClosedError,
  InputRefusedError,
  JobDefinitionError,
  NonRetryableError,
  RunPlanningError,
  RunVersionConflictError,
} from '../model/errors.ts';
import type { Run, RunRequest } from '../model/run.ts';
import { drainWindow } from '../engine/drain-window.ts';
import { withSpend } from '../model/spent.ts';
import type { Limiters } from '../ports/limiter.ts';
import { fakeClock } from '../testing/fake-clock.ts';
import { recordingSink } from '../testing/recording-sink.ts';
import {
  hang,
  ids,
  scoreOf,
  TOY_CONTENT,
  type ToyOptions,
  toyScoring,
  toyStopping,
} from '../testing/toy-jobs.ts';

const TENANT = 'tenant-engine';
const fast = { pollMs: 1, chunkConcurrency: 1 };
const quick = {
  initialIntervalMs: 2,
  backoffCoefficient: 1,
  maximumAttempts: 3,
};

const request = (
  n: number,
  over: Partial<RunRequest<{ n: number }>> = {},
): Omit<RunRequest<{ n: number }>, 'jobKey'> => ({
  input: { n },
  tenantId: TENANT,
  trigger: 'eval',
  requestedBy: null,
  budget: { maxItems: n },
  ...over,
});

/** The toy summary for n items, the failed ones left out. */
const expected = (n: number, failed: readonly string[] = []) => {
  const kept = ids(n).filter((r) => !failed.includes(r));
  return {
    count: kept.length,
    failed: failed.length,
    total: Math.round(kept.reduce((a, r) => a + scoreOf(r), 0) * 100),
  };
};

const run = (
  options: ToyOptions,
  n: number,
  over: Partial<RunRequest<{ n: number }>> = {},
  extra: {
    store?: MemoryJobStore;
    sinks?: ReturnType<typeof recordingSink>[];
  } = {},
) => {
  const toy = toyScoring(options);
  const store = extra.store ?? new MemoryJobStore();
  return {
    ...toy,
    store,
    outcome: runToCompletion(toy.job, request(n, over), {
      store,
      sinks: extra.sinks,
      limiters: localLimiters({ toy: { inFlight: 1 } }),
      executor: fast,
    }),
  };
};

describe('the step loop', () => {
  test('runs the steps in order, each reading the ones before, and records every output', async () => {
    const sink = recordingSink();
    const { outcome, store } = run({}, 7, { chunkSize: 3 }, { sinks: [sink] });
    const { run: done, output, steps } = await outcome;
    expect(done.status).toBe('completed');
    expect(output).toEqual(expected(7));
    expect(steps.map((s) => [s.name, s.status, s.attempts])).toEqual([
      ['list', 'completed', 1],
      ['score', 'completed', 1],
      ['summary', 'completed', 1],
    ]);
    expect(await store.stepOutput(done.id, 'list')).toEqual(ids(7));
    expect(steps[1]?.counts).toMatchObject({ total: 7, done: 7 });
    expect(steps[1]?.speculation).toEqual({
      speculated: 7,
      used: 7,
      overshoot: 0,
    });
    expect(sink.types((t) => !t.endsWith('progress'))).toEqual([
      'run.started',
      'step.started',
      'step.completed',
      'step.started',
      'step.completed',
      'step.started',
      'step.completed',
      'run.completed',
    ]);
  });

  test('events carry ids and counts, never content', async () => {
    const sink = recordingSink();
    const { outcome } = run({ bad: ['o001'] }, 4, {}, { sinks: [sink] });
    const { run: done } = await outcome;
    const text = JSON.stringify(sink.events);
    expect(text).not.toContain(TOY_CONTENT);
    expect(text).not.toContain('refuses');
    for (const e of sink.events)
      expect(e).toMatchObject({
        runId: done.id,
        jobKey: 'toy.scoring',
        jobVersion: done.jobVersion,
        tenantId: TENANT,
      });
    expect(sink.events.find((e) => e.type === 'item.failed')).toMatchObject({
      step: 'score',
      key: 'm1:o001',
      errorType: 'NonRetryableError',
    });
  });

  test('a step with a recorder saves its output there, and later steps read it back', async () => {
    const recorder = memoryRecorder<string[]>();
    const { outcome, store } = run({ recorder }, 3);
    const { run: done, output } = await outcome;
    expect(output).toEqual(expected(3));
    expect(recorder.saved.get(done.id)).toEqual(ids(3));
    expect(await store.stepOutput(done.id, 'list')).toBeUndefined();
  });

  test('a map step with no items is skipped, and the run goes on', async () => {
    const sink = recordingSink();
    const { outcome } = run({}, 0, {}, { sinks: [sink] });
    const { output, steps } = await outcome;
    expect(output).toEqual({ count: 0, failed: 0, total: 0 });
    expect(steps[1]?.status).toBe('skipped');
    expect(sink.types()).toContain('step.skipped');
  });

  test('a plain step retries a transient failure, and a non-retryable one fails the run', async () => {
    let tries = 0;
    const flaky = defineJob({
      key: 'toy.flaky',
      input: z.object({ fail: z.enum(['transient', 'never']) }),
      output: z.number(),
      steps: (s) =>
        s.add(
          'only',
          step({
            run: ({ input }) => {
              tries++;
              if (input.fail === 'never') throw new NonRetryableError('no');
              if (tries < 3) throw new Error('flaky');
              return tries;
            },
            retry: quick,
          }),
        ),
    });
    const sink = recordingSink();
    const store = new MemoryJobStore();
    const base = {
      tenantId: TENANT,
      trigger: 'eval' as const,
      requestedBy: null,
      budget: { maxItems: 1 },
    };
    const ok = await runToCompletion(
      flaky,
      { ...base, input: { fail: 'transient' } },
      { store, sinks: [sink], clock: fakeClock(), executor: fast },
    );
    expect(ok.output).toBe(3);
    expect(ok.steps[0]?.attempts).toBe(3);
    expect(sink.types((t) => t === 'step.retried')).toHaveLength(2);
    const bad = await runToCompletion(
      flaky,
      { ...base, input: { fail: 'never' } },
      { store, sinks: [sink], clock: fakeClock(), executor: fast },
    );
    expect(bad.run.status).toBe('failed');
    expect(bad.run.error?.type).toBe('NonRetryableError');
    expect(bad.output).toBeUndefined();
    expect(sink.types().slice(-2)).toEqual(['step.failed', 'run.failed']);
  });

  test('an input the job refuses is a planning error, and no run is made', async () => {
    const { job } = toyScoring();
    const store = new MemoryJobStore();
    await expect(
      startRun(
        { registry: createRegistry([job]), store },
        { ...request(1), jobKey: job.key, input: { n: -1 } },
      ),
    ).rejects.toBeInstanceOf(RunPlanningError);
    expect(await store.listRuns({ tenantId: TENANT, limit: 10 })).toEqual(
      [],
    );
  });
});

describe('a plain step under a cancel or a pause', () => {
  for (const how of ['cancel', 'pause'] as const)
    test(`a ${how} stops a step's retries, even unlimited ones, and the executor stops`, async () => {
      let attempts = 0;
      const job = defineJob({
        key: `toy.forever.${how}`,
        input: z.object({}),
        output: z.number(),
        steps: (s) =>
          s.add(
            'flaky',
            step({
              run: (): number => {
                attempts++;
                throw new Error('always');
              },
              retry: {
                initialIntervalMs: 5,
                backoffCoefficient: 1,
                maximumAttempts: 0,
              },
            }),
          ),
      });
      const store = new MemoryJobStore();
      const registry = createRegistry([job]);
      const { run: created } = await startRun(
        { registry, store },
        {
          jobKey: job.key,
          input: {},
          tenantId: TENANT,
          trigger: 'eval',
          requestedBy: null,
          budget: { maxItems: 0 },
        },
      );
      const executor = new InProcessExecutor({ store, registry, ...fast });
      await executor.submit(created.id);
      await new Promise((r) => setTimeout(r, 50));
      const control = { store, clock: systemClock };
      if (how === 'cancel') await cancelRun(control, created.id);
      else await pauseRun(control, created.id);
      await new Promise((r) => setTimeout(r, 20));
      const at = attempts;
      await new Promise((r) => setTimeout(r, 60));
      expect(attempts).toBe(at);
      await executor.stop();
      expect((await store.getRun(created.id)).status).toBe(
        how === 'cancel' ? 'canceled' : 'paused',
      );
    });
});

describe('where values live', () => {
  test('a run whose recorded input is missing fails before any step runs', async () => {
    const store = new MemoryJobStore({ keepsValues: false });
    const toy = toyScoring({ recorded: true });
    const registry = createRegistry([toy.job]);
    const { run: created } = await store.createRun({
      ...request(3),
      input: undefined,
      jobKey: toy.job.key,
      jobVersion: toy.job.version,
      collision: 'join',
    });
    const sink = recordingSink();
    const executor = new InProcessExecutor({
      store,
      registry,
      sinks: [sink],
      ...fast,
    });
    await executor.submit(created.id);
    await executor.stop();
    const { run: failed, steps } = await store.progress(created.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ type: 'RunPlanningError' });
    expect(failed.error?.message).toContain('input not recorded');
    expect(steps).toEqual([]);
    expect(toy.calls).toEqual([]);
  });

  test("a step whose output is 'none' and returns a value fails: nothing is dropped silently", async () => {
    const job = defineJob({
      key: 'toy.none',
      input: z.void(),
      output: z.void(),
      inputRecorder: 'none',
      steps: (s) =>
        s.add(
          'publish',
          step({
            recorder: 'none',
            // A step that breaks its own declaration: the types can't see it.
            run: () => 1 as unknown as undefined,
          }),
        ),
    });
    const { run: failed } = await runToCompletion(
      job,
      {
        input: undefined,
        tenantId: TENANT,
        trigger: 'eval',
        requestedBy: null,
        budget: { maxItems: 0 },
      },
      { store: new MemoryJobStore({ keepsValues: false }), executor: fast },
    );
    expect(failed.status).toBe('failed');
    expect(failed.error?.type).toBe('JobDefinitionError');
  });

  test('only a void output may take `none` (types)', () => {
    step({ run: () => undefined, recorder: 'none' });
    // @ts-expect-error a step with an output can't opt out of recording it
    step({ run: () => 1, recorder: 'none' });
  });

  test('a void plain step and a void map step take `none` and run on a store that keeps no values', async () => {
    const published: string[] = [];
    const job = defineJob({
      key: 'toy.publish',
      input: z.void(),
      output: z.void(),
      inputRecorder: 'none',
      steps: (s) =>
        s
          .add(
            'each',
            mapStep({
              items: () => ['a', 'b', 'c'],
              key: (r) => `pub:${r}`,
              run: async (batch) =>
                batch.map((b) => {
                  published.push(b.ref);
                  return undefined;
                }),
              results: 'none',
              batch: { max: 2 },
              limiter: 'toy',
            }),
          )
          .add(
            'done',
            step({
              run: ({ each }) => {
                expect(each.results.map((r) => r.ref)).toEqual(['a', 'b', 'c']);
              },
              recorder: 'none',
            }),
          ),
    });
    const base = {
      input: undefined,
      tenantId: TENANT,
      trigger: 'eval' as const,
      requestedBy: null,
      budget: { maxItems: 3 },
    };
    const store = new MemoryJobStore({ keepsValues: false });
    const first = await runToCompletion(job, base, { store, executor: fast });
    expect(first.run.status).toBe('completed');
    expect(published).toEqual(['a', 'b', 'c']);
    // Void results are never cached: a later run publishes again.
    await runToCompletion(job, base, { store, executor: fast });
    expect(published).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  test("a map step whose results are 'none' and returns a value fails: nothing is dropped silently", async () => {
    const job = defineJob({
      key: 'toy.none.map',
      input: z.void(),
      output: z.void(),
      inputRecorder: 'none',
      steps: (s) =>
        s
          .add(
            'each',
            mapStep({
              items: () => ['a'],
              key: (r) => r,
              // A batch that breaks its own declaration: the types can't see it.
              run: async (batch) => batch.map(() => 1 as unknown as undefined),
              results: 'none',
              batch: { max: 1 },
              limiter: 'toy',
            }),
          )
          .add('done', step({ run: () => undefined, recorder: 'none' })),
    });
    const { steps } = await runToCompletion(
      job,
      {
        input: undefined,
        tenantId: TENANT,
        trigger: 'eval',
        requestedBy: null,
        budget: { maxItems: 1 },
      },
      { store: new MemoryJobStore({ keepsValues: false }), executor: fast },
    );
    expect(steps[0]?.chunks.failed).toBe(1);
    expect(steps[0]?.counts.failed).toBe(1);
  });

  describe('a value the store keeps is plain JSON', () => {
    const voidRequest = {
      input: undefined,
      tenantId: TENANT,
      trigger: 'eval' as const,
      requestedBy: null,
      budget: { maxItems: 1 },
    };

    test('a plain step whose output is a Date fails the run, and nothing is stored', async () => {
      const store = new MemoryJobStore();
      const job = defineJob({
        key: 'toy.json.date',
        input: z.void(),
        output: z.void(),
        steps: (s) =>
          s
            .add('when', step({ run: () => new Date(0) }))
            .add('done', step({ run: () => undefined, recorder: 'none' })),
      });
      const { run: failed } = await runToCompletion(job, voidRequest, {
        store,
        executor: fast,
      });
      expect(failed.status).toBe('failed');
      expect(failed.error?.type).toBe('JobDefinitionError');
      expect(failed.error?.message).toContain('toy.json.date/when');
      expect(await store.stepOutput(failed.id, 'when')).toBeUndefined();
    });

    test('an output over the size cap fails the run', async () => {
      const job = defineJob({
        key: 'toy.json.big',
        input: z.void(),
        output: z.string(),
        steps: (s) =>
          s.add('big', step({ run: () => 'x'.repeat(MAX_STORED_VALUE_BYTES) })),
      });
      const { run: failed } = await runToCompletion(job, voidRequest, {
        store: new MemoryJobStore(),
        executor: fast,
      });
      expect(failed.status).toBe('failed');
      expect(failed.error?.type).toBe('JobDefinitionError');
    });

    test('a map step result that is not plain JSON fails its items', async () => {
      const job = defineJob({
        key: 'toy.json.map',
        input: z.void(),
        output: z.void(),
        steps: (s) =>
          s
            .add(
              'each',
              mapStep({
                items: () => ['a'],
                key: (r) => r,
                run: async (batch) =>
                  batch.map(() => new Map<string, number>()),
                batch: { max: 1 },
                limiter: 'toy',
              }),
            )
            .add('done', step({ run: () => undefined, recorder: 'none' })),
      });
      const { steps } = await runToCompletion(job, voidRequest, {
        store: new MemoryJobStore(),
        executor: fast,
      });
      expect(steps[0]?.counts.failed).toBe(1);
      expect(steps[0]?.counts.done).toBe(0);
    });

    test('an input that is not plain JSON is refused before a run is made', async () => {
      const store = new MemoryJobStore();
      const job = defineJob({
        key: 'toy.json.input',
        input: z.object({ since: z.date() }),
        output: z.void(),
        steps: (s) =>
          s.add('done', step({ run: () => undefined, recorder: 'none' })),
      });
      await expect(
        runToCompletion(
          job,
          { ...voidRequest, input: { since: new Date(0) } },
          { store, executor: fast },
        ),
      ).rejects.toBeInstanceOf(JobDefinitionError);
      expect(
        await store.listRuns({
          tenantId: TENANT,
          jobKey: 'toy.json.input',
          limit: 10,
        }),
      ).toEqual([]);
    });

    test('an input over the stored-value limit is refused as the request’s (RunPlanningError), before a run is made', async () => {
      const store = new MemoryJobStore();
      const job = defineJob({
        key: 'toy.big.input',
        input: z.object({ note: z.string() }),
        output: z.void(),
        steps: (s) =>
          s.add('done', step({ run: () => undefined, recorder: 'none' })),
      });
      await expect(
        runToCompletion(
          job,
          {
            ...voidRequest,
            input: { note: 'x'.repeat(MAX_STORED_VALUE_BYTES) },
          },
          { store, executor: fast },
        ),
      ).rejects.toBeInstanceOf(RunPlanningError);
      expect(
        await store.listRuns({
          tenantId: TENANT,
          jobKey: 'toy.big.input',
          limit: 10,
        }),
      ).toEqual([]);
    });

    test('nonJsonPart names the first part plain JSON cannot carry', () => {
      expect(nonJsonPart({ a: [1, 'b', { c: null }] })).toBeNull();
      expect(nonJsonPart({ a: { b: 1n } })).toBe('$.a.b: a bigint');
      expect(nonJsonPart([1, undefined])).toBe('$[1]: undefined in an array');
      expect(nonJsonPart({ n: Number.NaN })).toBe(
        '$.n: NaN is not a finite number',
      );
      expect(nonJsonPart({ d: new Date(0) })).toBe(
        '$.d: a Date instance, not a plain object',
      );
      expect(nonJsonPart({ skipped: undefined })).toBeNull();
    });

    test('nonJsonPart takes a plain object of another realm, and still refuses its instances', () => {
      // What a store read gives a job under Jest's VM, or after a structured clone in another realm.
      expect(
        nonJsonPart(runInNewContext('({ a: { b: [1, { c: 2 }] } })')),
      ).toBeNull();
      expect(nonJsonPart(runInNewContext('Object.create(null)'))).toBeNull();
      expect(nonJsonPart({ d: runInNewContext('new Date(0)') })).toBe(
        '$.d: a Date instance, not a plain object',
      );
      expect(nonJsonPart({ m: runInNewContext('new Map()') })).toBe(
        '$.m: a Map instance, not a plain object',
      );
    });
  });

  test('a dedupe hit never records its own input into a run whose input was lost', async () => {
    const store = new MemoryJobStore({ keepsValues: false });
    const toy = toyScoring({ recorded: true });
    const registry = createRegistry([toy.job]);
    // A crash between createRun and the input's save.
    const { run: lost } = await store.createRun({
      ...request(3, { dedupeKey: 'd' }),
      input: undefined,
      jobKey: toy.job.key,
      jobVersion: toy.job.version,
      collision: 'join',
    });
    const { run: found } = await startRun(
      { registry, store },
      { ...request(5, { dedupeKey: 'd' }), jobKey: toy.job.key },
    );
    expect(found.id).toBe(lost.id);
    expect(await toy.recorders?.input.load(lost.id)).toBeUndefined();
  });

  test('a dry run reaches every step', async () => {
    const seen: boolean[] = [];
    const job = defineJob({
      key: 'toy.dry',
      input: z.object({}),
      output: z.boolean(),
      steps: (s) =>
        s.add(
          'look',
          step({
            run: ({ dryRun }) => {
              seen.push(dryRun);
              return dryRun;
            },
          }),
        ),
    });
    const base = {
      input: {},
      tenantId: TENANT,
      trigger: 'eval' as const,
      requestedBy: null,
      budget: { maxItems: 0 },
    };
    const store = new MemoryJobStore();
    expect(
      (
        await runToCompletion(
          job,
          { ...base, dryRun: true },
          { store, executor: fast },
        )
      ).output,
    ).toBe(true);
    expect(
      (await runToCompletion(job, base, { store, executor: fast })).run.dryRun,
    ).toBe(false);
    expect(seen).toEqual([true, false]);
  });
});

describe('dedupe', () => {
  test('at most one open run per dedupe key, per tenant; a finished one starts afresh', async () => {
    const { job } = toyScoring();
    const store = new MemoryJobStore();
    const deps = { registry: createRegistry([job]), store };
    const start = (over: Partial<RunRequest<{ n: number }>> = {}) =>
      startRun(deps, { ...request(2, over), jobKey: job.key });
    const ask = async (over: Partial<RunRequest<{ n: number }>> = {}) =>
      (await start(over)).run;
    const first = await start({ dedupeKey: 'tune:x' });
    expect(first.created).toBe(true);
    const a = first.run;
    const hit = await start({ dedupeKey: 'tune:x' });
    expect(hit.created).toBe(false);
    expect(hit.run.id).toBe(a.id);
    expect(
      (await ask({ dedupeKey: 'tune:x', tenantId: 'tenant-b' })).id,
    ).not.toBe(a.id);
    expect((await ask()).id).not.toBe(a.id);
    const done = await runToCompletion(
      job,
      request(2, { dedupeKey: 'tune:x' }),
      { store, executor: fast },
    );
    expect(done.run.id).toBe(a.id);
    expect(done.run.status).toBe('completed');
    expect((await ask({ dedupeKey: 'tune:x' })).id).not.toBe(a.id);
  });

  test('an open run made by another version of the definition is refused', async () => {
    const store = new MemoryJobStore();
    const v1 = toyScoring().job;
    const v2 = toyScoring({ batchMax: 5 }).job;
    await startRun(
      { registry: createRegistry([v1]), store },
      { ...request(2, { dedupeKey: 'd' }), jobKey: v1.key },
    );
    const err = await startRun(
      { registry: createRegistry([v2]), store },
      { ...request(2, { dedupeKey: 'd' }), jobKey: v2.key },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunVersionConflictError);
    expect(err).toBeInstanceOf(JobDefinitionError);
    expect(err).toMatchObject({ runVersion: v1.version, version: v2.version });
  });
});

describe('admit', () => {
  const admitted = (
    admit: JobOptions<{ n: number }, unknown, unknown>['admit'],
  ) =>
    defineJob({
      key: 'toy.admit',
      input: z.object({ n: z.coerce.number() }),
      output: z.number(),
      steps: (s) => s.add('only', step({ run: async (ctx) => ctx.input.n })),
      admit,
    });

  test('a refusal propagates, creates no run and holds no dedupe key', async () => {
    let refuse = true;
    const job = admitted(async ({ n }) => {
      if (refuse && n === 2) throw new InputRefusedError('nope', 'no twos');
    });
    const store = new MemoryJobStore();
    const deps = { registry: createRegistry([job]), store };
    const req = { ...request(2, { dedupeKey: 'k' }), jobKey: job.key };
    const err = await startRun(deps, req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputRefusedError);
    expect(err).toMatchObject({ code: 'nope' });
    expect(await store.listRuns({ tenantId: TENANT, limit: 10 })).toEqual(
      [],
    );
    refuse = false;
    const { created } = await startRun(deps, req);
    expect(created).toBe(true);
  });

  test('sees the parsed input, the tenant and dryRun', async () => {
    const seen: unknown[] = [];
    const job = admitted(async (input, request) => {
      seen.push({ input, request });
    });
    const deps = {
      registry: createRegistry([job]),
      store: new MemoryJobStore(),
    };
    await startRun(deps, {
      ...request(2),
      input: { n: '3' },
      jobKey: job.key,
      dryRun: true,
    });
    expect(seen).toEqual([
      {
        input: { n: 3 },
        request: {
          tenantId: TENANT,
          dryRun: true,
          outputOf: expect.any(Function),
        },
      },
    ]);
  });
});

describe('map steps', () => {
  test('a killed run resumes without asking again for finished items', async () => {
    // 25 items, chunks of 10, calls of 2 and one call in flight: 13 calls without a crash. The process dies during
    // the 4th call (after 3 recorded calls, 6 items); a new process sweeps the expired claim and finishes, asking
    // only the 19 items with no result.
    const clock = fakeClock();
    const store = new MemoryJobStore({ now: clock.now });
    const req = request(25, { chunkSize: 10, dedupeKey: 'resume' });
    let reached: () => void = () => {};
    const atFourth = new Promise<void>((r) => {
      reached = r;
    });
    const before = toyScoring({
      onCall: (n, _call, signal) => {
        if (n < 4) return undefined;
        reached();
        return hang(signal);
      },
    });
    const crash = new AbortController();
    const dying = runToCompletion(before.job, req, {
      store,
      clock,
      signal: crash.signal,
      limiters: localLimiters({ toy: { inFlight: 1 } }),
      executor: fast,
    });
    await atFourth;
    crash.abort(new Error('the process died'));
    await expect(dying).rejects.toThrow('the process died');
    const finished = new Set(before.calls.slice(0, 3).flatMap((c) => c.refs));
    expect(finished.size).toBe(6);

    clock.advance(10 * 60_000);
    const after = toyScoring();
    const { run: done, output } = await runToCompletion(after.job, req, {
      store,
      clock,
      limiters: localLimiters({ toy: { inFlight: 1 } }),
      executor: fast,
    });
    const asked = after.calls.flatMap((c) => c.refs);
    expect(after.calls).toHaveLength(10); // chunk 0's last 4 items in 2 calls, then 5 + 3
    expect(asked.filter((r) => finished.has(r))).toEqual([]);
    expect(new Set(asked).size).toBe(19);
    expect(done.status).toBe('completed');
    expect(done.spend.calls).toBe(13);
    expect(output).toEqual(expected(25));
  });

  test('a transient failure leaves the chunk pending, and it retries after backoff', async () => {
    const sink = recordingSink();
    const { outcome, calls } = run(
      { transientCalls: 2, retry: quick },
      4,
      {},
      { sinks: [sink] },
    );
    const { run: done, output, steps } = await outcome;
    expect(done.status).toBe('completed');
    expect(output).toEqual(expected(4));
    expect(calls.length).toBe(4);
    expect(steps[1]?.counts).toMatchObject({ done: 4, failed: 0 });
    expect(sink.events.filter((e) => e.type === 'step.retried')).toMatchObject([
      { step: 'score', chunk: 0, errorType: 'Error', attempt: 1 },
    ]);
  });

  test('attempts run out: the chunk fails its items, and the run still completes with them counted', async () => {
    const { outcome } = run({ transientCalls: 100, retry: quick }, 3);
    const { run: done, output, steps } = await outcome;
    expect(done.status).toBe('completed');
    expect(output).toEqual({ count: 0, failed: 3, total: 0 });
    expect(steps[1]?.chunks.failed).toBe(1);
  });

  test('a deterministic failure splits the batch until the bad item is alone; it alone fails', async () => {
    const { outcome, calls } = run({ bad: ['o005'], batchMax: 4 }, 8);
    const { output, steps } = await outcome;
    expect(output).toEqual(expected(8, ['o005']));
    expect(calls.map((c) => c.refs)).toEqual([
      ['o000', 'o001', 'o002', 'o003'],
      ['o004', 'o005', 'o006', 'o007'],
      ['o004', 'o005'],
      ['o006', 'o007'],
      ['o004'],
      ['o005'],
    ]);
    expect(steps[1]?.counts).toMatchObject({ done: 7, failed: 1 });
  });

  test('a result its schema refuses fails that item alone, whatever the chunk size', async () => {
    const asked: string[][] = [];
    const job = defineJob({
      key: 'toy.schema',
      input: z.object({}),
      output: z.object({
        results: z.array(z.unknown()),
        failed: z.array(z.object({ ref: z.string() }).passthrough()),
      }),
      steps: (s) =>
        s.add(
          'ask',
          mapStep({
            items: () => ids(8),
            key: (r) => `m1:${r}`,
            run: async (batch) => {
              asked.push(batch.map((b) => b.ref));
              // o001's answer breaks the provider's contract: the types can't see it.
              return batch.map((b) =>
                b.ref === 'o001' ? ('not a number' as unknown as number) : 1,
              );
            },
            result: z.number(),
            batch: { max: 4 },
            limiter: 'toy',
            retry: quick,
          }),
        ),
    });
    for (const chunkSize of [1, 2, 8]) {
      asked.length = 0;
      const sink = recordingSink();
      const { output } = await runToCompletion(
        job,
        {
          input: {},
          tenantId: TENANT,
          trigger: 'eval',
          requestedBy: null,
          budget: { maxItems: 8 },
          chunkSize,
        },
        { store: new MemoryJobStore(), sinks: [sink], executor: fast },
      );
      expect(output?.failed.map((f) => f.ref)).toEqual(['o001']);
      expect(output?.results).toHaveLength(7);
      // Never retried: each item asked once.
      expect(asked.flat().sort()).toEqual(ids(8));
      expect(sink.events.filter((e) => e.type === 'item.failed')).toMatchObject(
        [{ key: 'm1:o001', errorType: 'ResultSchemaError' }],
      );
    }
  });

  test('a reservation is settled by its estimate: calls that cost less than estimated never pause a run with budget left', async () => {
    let calls = 0;
    const job = defineJob({
      key: 'toy.cost',
      input: z.object({}),
      output: z.object({
        results: z.array(z.unknown()),
        failed: z.array(z.unknown()),
      }),
      steps: (s) =>
        s.add(
          'ask',
          mapStep({
            items: () => ids(20),
            key: (r) => r,
            run: async (batch) => {
              calls++;
              return { results: batch.map(() => 1), spend: { costUsd: 0.1 } };
            },
            cost: () => ({ usd: 1 }),
            batch: { max: 2 },
            limiter: 'toy',
          }),
        ),
    });
    const { run: done, output } = await runToCompletion(
      job,
      {
        input: {},
        tenantId: TENANT,
        trigger: 'eval',
        requestedBy: null,
        budget: { maxItems: 20, maxUsd: 5 },
      },
      {
        store: new MemoryJobStore(),
        limiters: localLimiters({ toy: { inFlight: 1 } }),
        executor: fast,
      },
    );
    expect(done.status).toBe('completed');
    expect(calls).toBe(10);
    expect(done.spend.costUsd).toBeCloseTo(1, 6);
    expect(done.reservedUsd).toBe(0);
    expect(output?.results).toHaveLength(20);
  });

  test("a failed call returns its reservation at once, so the chunk's next call fits the budget", async () => {
    let calls = 0;
    const job = defineJob({
      key: 'toy.refund',
      input: z.object({}),
      output: z.object({
        results: z.array(z.unknown()),
        failed: z.array(z.unknown()),
      }),
      steps: (s) =>
        s.add(
          'ask',
          mapStep({
            items: () => ids(2),
            key: (r) => r,
            run: async (batch) => {
              calls++;
              if (calls === 1) throw new Error('503');
              return { results: batch.map(() => 1), spend: { costUsd: 0 } };
            },
            cost: () => ({ usd: 1 }),
            batch: { max: 1 },
            limiter: 'toy',
            retry: quick,
          }),
        ),
    });
    const { run: done } = await runToCompletion(
      job,
      {
        input: {},
        tenantId: TENANT,
        trigger: 'eval',
        requestedBy: null,
        // Room for one call in flight: a reservation the failed call kept would refuse the next.
        budget: { maxItems: 2, maxUsd: 1.5 },
      },
      {
        store: new MemoryJobStore(),
        limiters: localLimiters({ toy: { inFlight: 1 } }),
        executor: fast,
      },
    );
    expect(done.status).toBe('completed');
    expect(done.reservedUsd).toBe(0);
  });

  test('under a fake clock, a transient failure waits out its backoff on the clock and the run completes', async () => {
    const clock = fakeClock();
    const toy = toyScoring({ transientCalls: 1 });
    const { run: done, output } = await runToCompletion(toy.job, request(4), {
      store: new MemoryJobStore({ now: clock.now }),
      clock,
      executor: fast,
    });
    expect(done.status).toBe('completed');
    expect(output).toEqual(expected(4));
  });

  test('a later run of the same meaning reads stored results instead of asking again', async () => {
    const store = new MemoryJobStore();
    const first = run({}, 4, {}, { store });
    await first.outcome;
    const second = run({}, 6, {}, { store });
    const { output, steps } = await second.outcome;
    expect(output).toEqual(expected(6));
    expect(second.calls.flatMap((c) => c.refs)).toEqual(['o004', 'o005']);
    expect(steps[1]?.counts).toMatchObject({ cached: 4, done: 2 });
    // A refresh re-asks every item.
    const third = run({}, 2, { cache: 'refresh' }, { store });
    await third.outcome;
    expect(third.calls.flatMap((c) => c.refs)).toEqual(['o000', 'o001']);
  });
});

describe('early stop and speculation', () => {
  test('the result never depends on how far ahead the engine worked; speculation is recorded', async () => {
    const shapes = [
      { chunkSize: 1, chunkConcurrency: 1 },
      { chunkSize: 4, chunkConcurrency: 3 },
      { chunkSize: 1000, chunkConcurrency: 1 },
    ];
    const outcomes = [];
    for (const shape of shapes) {
      const toy = toyStopping();
      const outcome = await runToCompletion(
        toy.job,
        request(40, { chunkSize: shape.chunkSize }),
        {
          store: new MemoryJobStore(),
          executor: { pollMs: 1, chunkConcurrency: shape.chunkConcurrency },
        },
      );
      outcomes.push({ ...outcome, asked: toy.calls.flatMap((c) => c.refs) });
    }
    // The stop is the third item under 0.2: o000 (0), o003 (0.11), o011 (0.07), so 12 items are used.
    const stopped = ids(12);
    for (const o of outcomes) {
      expect(o.output).toEqual({
        count: 12,
        failed: 0,
        total: Math.round(stopped.reduce((a, r) => a + scoreOf(r), 0) * 100),
      });
      const spec = o.steps[1]?.speculation;
      expect(spec?.used).toBe(12);
      expect(spec?.overshoot).toBe((spec?.speculated ?? 0) - 12);
    }
    // Narrow: one item at a time stops right at the stop. Wide: one chunk of everything reads the stop between its
    // batches, so it overshoots by what was in flight, never to the chunk's edge.
    expect(outcomes[0]?.steps[1]?.speculation).toEqual({
      speculated: 12,
      used: 12,
      overshoot: 0,
    });
    const wide = outcomes[2]?.steps[1]?.speculation;
    expect(wide?.used).toBe(12);
    // The toy limiter is 6 wide (`DEFAULT_LIMITER`), its batches 2 items.
    expect(wide?.speculated).toBeLessThanOrEqual(12 + 6 * 2);
    expect(outcomes[0]?.asked).toEqual(stopped);
    expect(outcomes[0]?.steps[1]?.counts.skipped).toBe(28);
  });
});

describe('a version no longer deployed', () => {
  test('an open run of it fails on its next advance with JobVersionGoneError, rather than hanging', async () => {
    const store = new MemoryJobStore();
    const toy = toyScoring();
    const registry = createRegistry([toy.job]);
    const { run } = await store.createRun({
      jobKey: toy.job.key,
      jobVersion: 'an-older-version',
      input: { n: 2 },
      tenantId: 'tenant-version',
      trigger: 'eval',
      requestedBy: null,
      budget: { maxItems: 2 },
      chunkSize: 2,
    });
    const executor = new InProcessExecutor({ store, registry, pollMs: 1 });
    await executor.start();
    await executor.submit(run.id);
    for (let i = 0; i < 200; i++) {
      if ((await store.getRun(run.id)).status === 'failed') break;
      await new Promise((r) => setTimeout(r, 2));
    }
    await executor.stop();
    const failed = await store.getRun(run.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.type).toBe('JobVersionGoneError');
  });
});

describe('a rolling deploy (review #969)', () => {
  test('a long-up executor leaves a run a newer version just started, and fails it only once it is older than the window', async () => {
    const clock = fakeClock();
    const store = new MemoryJobStore({ now: clock.now });
    const toy = toyScoring();
    const registry = createRegistry([toy.job]);
    const executor = new InProcessExecutor({ store, registry, clock, pollMs: 1, versionGraceMs: 1_000 });
    await executor.start();
    clock.advance(60 * 60_000); // this old worker has been up for an hour
    const { run } = await store.createRun({
      jobKey: toy.job.key,
      jobVersion: 'a-newer-version',
      input: { n: 2 },
      tenantId: 'tenant-version',
      trigger: 'eval',
      requestedBy: null,
      budget: { maxItems: 2 },
      chunkSize: 2,
    });
    await executor.submit(run.id).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    expect((await store.getRun(run.id)).status).toBe('pending');
    clock.advance(1_000);
    await executor.submit(run.id);
    for (let i = 0; i < 200 && (await store.getRun(run.id)).status !== 'failed'; i++)
      await new Promise((r) => setTimeout(r, 2));
    await executor.stop();
    expect((await store.getRun(run.id)).error?.type).toBe('JobVersionGoneError');
  });

  test("drainWindow: its own version is worked; another is left until the process and the run both outlast the window", () => {
    const clock = fakeClock();
    const window = drainWindow(clock, 1_000);
    const run = (createdAt: Date, jobVersion = 'other') => ({ createdAt, jobVersion }) as Run;
    expect(window.standing({ version: 'v' }, run(clock.now(), 'v'))).toBe('ours');
    const old = run(new Date(clock.now().getTime() - 5_000));
    expect(window.standing({ version: 'v' }, old)).toBe('leave'); // this process just booted
    clock.advance(1_000);
    expect(window.standing({ version: 'v' }, old)).toBe('gone');
    expect(window.standing({ version: 'v' }, run(clock.now()))).toBe('leave'); // a run just made by a newer replica
    expect(drainWindow(clock, 0).gone(run(clock.now()))).toBe(true);
  });
});

describe('the stop is read between batches', () => {
  test('a stop that trips after 2 batches of a 1000-item chunk issues no more than limiter-width batches past it', async () => {
    const WIDTH = 2;
    const BATCH = 10;
    let calls = 0;
    const job = defineJob({
      key: 'toy.stop-in-chunk',
      input: z.object({}),
      output: z.object({ kept: z.number() }),
      steps: (s) =>
        s
          .add(
            'score',
            mapStep({
              items: () => Array.from({ length: 1000 }, (_, i) => String(i)),
              key: (r) => r,
              run: async (batch) => {
                calls++;
                await new Promise((r) => setTimeout(r, 1));
                return batch.map((b) => Number(b.ref));
              },
              batch: { max: BATCH },
              limiter: 'narrow',
              // Stop after the 20th item: the end of the second batch.
              stopWhen: (o) => o.ok && o.result === 2 * BATCH - 1,
            }),
          )
          .add(
            'sum',
            step({ run: ({ score }) => ({ kept: score.results.length }) }),
          ),
    });
    const store = new MemoryJobStore();
    const outcome = await runToCompletion(
      job,
      {
        input: {},
        tenantId: 'tenant-stop',
        trigger: 'eval',
        requestedBy: null,
        budget: { maxItems: 1000 },
        chunkSize: 1000,
      },
      {
        store,
        limiters: localLimiters({ narrow: { inFlight: WIDTH } }),
        executor: { pollMs: 1 },
      },
    );
    expect(outcome.output).toEqual({ kept: 2 * BATCH });
    expect(calls).toBeLessThanOrEqual(2 + WIDTH);
    const [score] = await store.stepStates(outcome.run.id);
    expect(score?.speculation?.used).toBe(2 * BATCH);
    expect(score?.speculation?.overshoot).toBe((calls - 2) * BATCH);
    expect(score?.counts.skipped).toBe(1000 - calls * BATCH);
  });
});

describe('a stop ends planning', () => {
  test('a paged source stops being paged once the stop is found', async () => {
    let pages = 0;
    const job = defineJob({
      key: 'toy.stop-planning',
      input: z.object({}),
      output: z.object({ kept: z.number() }),
      steps: (s) =>
        s
          .add(
            'score',
            mapStep({
              items: () => ({
                async page(cursor: string | null, limit: number) {
                  pages++;
                  await new Promise((r) => setTimeout(r, 20));
                  const from = Number(cursor ?? 0);
                  const refs = Array.from({ length: limit }, (_, i) =>
                    String(from + i),
                  );
                  const next = from + limit;
                  return { refs, next: next >= 1000 ? null : String(next) };
                },
              }),
              key: (r) => r,
              run: async (batch) => batch.map((b) => Number(b.ref)),
              batch: { max: 5 },
              limiter: 'toy',
              stopWhen: (o) => o.ok && o.result === 2,
            }),
          )
          .add(
            'sum',
            step({ run: ({ score }) => ({ kept: score.results.length }) }),
          ),
    });
    const store = new MemoryJobStore();
    const outcome = await runToCompletion(
      job,
      {
        input: {},
        tenantId: 'tenant-stop',
        trigger: 'eval',
        requestedBy: null,
        budget: { maxItems: 1000 },
        chunkSize: 10,
      },
      { store, executor: { pollMs: 1, pageSize: 10 } },
    );
    expect(outcome.output).toEqual({ kept: 3 });
    // Without the stop ending planning, all 100 pages would be read.
    expect(pages).toBeLessThan(5);
    const [score] = await store.stepStates(outcome.run.id);
    expect(score?.counts.total).toBeLessThan(50);
  });
});

describe('the stop reads incrementally', () => {
  /** A store that counts the item rows its reads return. */
  class CountingStore extends MemoryJobStore {
    rows = 0;
    reads = 0;
    largest = 0;
    override async items(
      ...args: Parameters<MemoryJobStore['items']>
    ): ReturnType<MemoryJobStore['items']> {
      const out = await super.items(...args);
      this.rows += out.length;
      // A whole-step read (the output, once) is not the stop's.
      if (args[2]) {
        this.reads++;
        this.largest = Math.max(this.largest, out.length);
      }
      return out;
    }
  }
  const rowsFor = async (n: number) => {
    const job = defineJob({
      key: `toy.stop-reads-${n}`,
      input: z.object({}),
      output: z.unknown(),
      steps: (s) =>
        s.add(
          'score',
          mapStep({
            items: () => Array.from({ length: n }, (_, i) => String(i)),
            key: (r) => r,
            run: async (batch) => batch.map(() => 1),
            batch: { max: 5 },
            limiter: 'toy',
            // Never trips, so every batch and every settle reads it.
            stopWhen: () => false,
          }),
        ),
    });
    const store = new CountingStore();
    const outcome = await runToCompletion(
      job,
      {
        input: {},
        tenantId: 'tenant-stop',
        trigger: 'eval',
        requestedBy: null,
        budget: { maxItems: n },
        chunkSize: 50,
      },
      { store, executor: { pollMs: 1 } },
    );
    expect(outcome.run.status).toBe('completed');
    return store;
  };

  test("reading the stop after each batch costs what settled since, not the step's size", async () => {
    for (const n of [400, 1600]) {
      const store = await rowsFor(n);
      // One read is bounded whatever the step's size, and the reads together cost a few rows each plus about twice
      // the step (each item read settled once, a doubling window's overshoot, and the output's two reads at the end):
      // linear in the step. A whole-prefix re-read per settle costs about reads × n / 2.
      expect(store.largest).toBeLessThanOrEqual(STOP_READ_MAX);
      expect(store.rows).toBeLessThanOrEqual(
        store.reads * STOP_READ_FIRST + 5 * n,
      );
      expect(store.rows).toBeLessThan((store.reads * n) / 8);
    }
  });
});

describe('the stop reads only the settled prefix', () => {
  test('an item settled ahead of an unsettled one is never read', async () => {
    const store = new MemoryJobStore();
    const { job } = toyStopping();
    const registry = createRegistry([job]);
    const { run: created } = await startRun(
      { registry, store },
      { ...request(6), jobKey: job.key, chunkSize: 2 },
    );
    await store.transition(created.id, { to: 'running', from: 'pending' });
    await store.startStep(
      created.id,
      { name: 'score', index: 1, kind: 'map' },
      { attempts: 0 },
    );
    await store.planItems(created.id, 'score', {
      refs: ids(6),
      keys: ids(6).map((r) => `m1:${r}`),
      next: null,
    });
    const claims = await store.claimChunks('w', 3, 60_000);
    // Chunk 1 (o002, o003) settles before chunk 0 does.
    const second = claims.find((c) => c.index === 1);
    if (!second) throw new Error('no claim');
    await store.writeResults(
      second,
      {
        done: ['o002', 'o003'].map((r) => ({
          key: `m1:${r}`,
          ref: r,
          result: scoreOf(r),
        })),
      },
      { calls: 1, inputTokens: 0, costUsd: 0 },
    );
    const run = await store.getRun(created.id);
    const items = await store.items(created.id, 'score');
    expect(
      await settledPrefix(
        store,
        run,
        'score',
        mapStepOf(job, 'score').erased,
        items,
      ),
    ).toEqual([]);
  });
});

describe('budget', () => {
  test('a spent budget pauses the run, never fails it; resuming with more finishes it with the same result', async () => {
    const store = new MemoryJobStore();
    const sink = recordingSink();
    const req = request(10, {
      dedupeKey: 'budget',
      budget: { maxItems: 10, maxCalls: 2 },
    });
    const first = toyScoring();
    const paused = await runToCompletion(first.job, req, {
      store,
      sinks: [sink],
      executor: fast,
    });
    expect(paused.run).toMatchObject({
      status: 'paused',
      pauseReason: 'budget',
    });
    expect(paused.output).toBeUndefined();
    expect(first.calls).toHaveLength(2);
    expect(sink.types((t) => t.startsWith('run.'))).toEqual([
      'run.started',
      'run.paused',
    ]);
    await resumeRun(
      { store, clock: systemClock, events: sink },
      paused.run.id,
      { budget: { maxItems: 10 } },
    );
    const second = toyScoring();
    const done = await runToCompletion(second.job, req, {
      store,
      sinks: [sink],
      executor: fast,
    });
    expect(done.run.id).toBe(paused.run.id);
    expect(done.run.status).toBe('completed');
    expect(done.output).toEqual(expected(10));
    expect(second.calls).toHaveLength(3);
    expect(sink.types((t) => t.startsWith('run.'))).toEqual([
      'run.started',
      'run.paused',
      'run.resumed',
      'run.completed',
    ]);
  });

  test('a passed deadline pauses the run between steps', async () => {
    const clock = fakeClock();
    const store = new MemoryJobStore({ now: clock.now });
    const slow = defineJob({
      key: 'toy.deadline',
      input: z.object({}),
      output: z.number(),
      steps: (s) =>
        s
          .add(
            'first',
            step({
              run: () => {
                clock.advance(5_000);
                return 1;
              },
            }),
          )
          .add('second', step({ run: ({ first }) => first + 1 })),
    });
    const { run: paused, steps } = await runToCompletion(
      slow,
      {
        input: {},
        tenantId: TENANT,
        trigger: 'eval',
        requestedBy: null,
        budget: {
          maxItems: 0,
          deadline: new Date(clock.now().getTime() + 1_000),
        },
      },
      { store, clock, executor: fast },
    );
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'deadline' });
    expect(steps.map((s) => [s.name, s.status])).toEqual([
      ['first', 'completed'],
    ]);
  });
});

describe('cancel', () => {
  test('a cancel stops the run; the worker in flight loses its claim and nothing else is asked', async () => {
    const store = new MemoryJobStore();
    const sink = recordingSink();
    let reached: (signal: AbortSignal) => void = () => {};
    const atSecond = new Promise<AbortSignal>((r) => {
      reached = r;
    });
    const toy = toyScoring({
      onCall: (n, _call, signal) => {
        if (n !== 2) return undefined;
        reached(signal);
        return hang(signal);
      },
    });
    const registry = createRegistry([toy.job]);
    const executor = new InProcessExecutor({
      store,
      registry,
      sinks: [sink],
      limiters: localLimiters({ toy: { inFlight: 1 } }),
      claimTtlMs: 30,
      ...fast,
    });
    const { run: created } = await startRun(
      { registry, store },
      { ...request(10), jobKey: toy.job.key },
    );
    await executor.start();
    await executor.submit(created.id);
    const inFlight = await atSecond;
    await cancelRun(
      { store, clock: systemClock, events: executor.sink },
      created.id,
    );
    // The heartbeat sees the cancel and aborts the chunk in flight.
    await new Promise((r) =>
      inFlight.addEventListener('abort', r, { once: true }),
    );
    await executor.stop();
    const { run: canceled, steps } = await store.progress(created.id);
    expect(canceled.status).toBe('canceled');
    expect(steps[1]?.chunks.canceled).toBe(1);
    expect(steps[1]?.counts.done).toBe(2);
    expect(toy.calls).toHaveLength(2);
    expect(sink.types((t) => t.startsWith('run.'))).toEqual([
      'run.started',
      'run.canceled',
    ]);
  });
});

describe('spend and the pause contract (t43, t44)', () => {
  const spendJob = (
    key: string,
    run: (
      batch: readonly { ref: string }[],
      signal: AbortSignal,
    ) => Promise<BatchResult<number> | readonly number[]>,
    n = 4,
  ) =>
    defineJob({
      key,
      input: z.object({}),
      output: z.object({
        results: z.array(z.unknown()),
        failed: z.array(z.object({ ref: z.string() }).passthrough()),
      }),
      steps: (s) =>
        s.add(
          'ask',
          mapStep({
            items: () => ids(n),
            key: (r) => `m1:${r}`,
            run: (batch, { signal }) => run(batch, signal),
            result: z.number(),
            batch: { max: 4 },
            limiter: 'toy',
            retry: quick,
          }),
        ),
    });
  const req = (n = 4) => ({
    input: {},
    tenantId: TENANT,
    trigger: 'eval' as const,
    requestedBy: null,
    budget: { maxItems: n },
  });

  test('a call that paid and then threw records its spend (withSpend), and the retry records its own', async () => {
    let calls = 0;
    const job = spendJob('toy.thrown-spend', async (batch) => {
      calls++;
      if (calls === 1)
        throw withSpend(new Error('503 after the provider charged'), {
          inputTokens: 40,
          costUsd: 0.25,
        });
      return { results: batch.map(() => 1), spend: { costUsd: 0.5 } };
    });
    const store = new MemoryJobStore();
    const { run, output } = await runToCompletion(job, req(), {
      store,
      executor: fast,
    });
    expect(run.status).toBe('completed');
    expect(output?.results).toHaveLength(4);
    expect(calls).toBe(2);
    expect(run.spend).toEqual({ calls: 2, inputTokens: 40, costUsd: 0.75 });
  });

  test('withSpend keeps the error itself: its type and its retry class', () => {
    const err = new NonRetryableError('refused');
    const marked = withSpend(err, { costUsd: 1 });
    expect(marked).toBe(err);
    expect(marked).toBeInstanceOf(NonRetryableError);
    expect(withSpend('a string', {})).toBeInstanceOf(Error);
  });

  test('a batch fails items without throwing: they fail alone, never retried, and the call keeps its spend', async () => {
    const asked: string[][] = [];
    const job = spendJob('toy.batch-failed', async (batch) => {
      asked.push(batch.map((b) => b.ref));
      return {
        results: batch.map(() => 1),
        failed: [{ index: 1, errorType: 'Unanswerable' }],
        spend: { inputTokens: 10, costUsd: 0.1 },
      };
    });
    const sink = recordingSink();
    const store = new MemoryJobStore();
    const { run, output, steps } = await runToCompletion(job, req(), {
      store,
      sinks: [sink],
      executor: fast,
    });
    expect(run.status).toBe('completed');
    expect(output?.failed.map((f) => f.ref)).toEqual(['o001']);
    expect(output?.results).toHaveLength(3);
    expect(asked).toEqual([ids(4)]);
    expect(run.spend).toEqual({ calls: 1, inputTokens: 10, costUsd: 0.1 });
    expect(steps[0]?.counts).toMatchObject({ done: 3, failed: 1 });
    expect(sink.events.filter((e) => e.type === 'item.failed')).toMatchObject([
      { key: 'm1:o001', errorType: 'Unanswerable' },
    ]);
  });

  test("a batch naming a failed item it doesn't hold is a definition error: it fails the chunk's pending items", async () => {
    const job = spendJob('toy.batch-failed-bad', async (batch) => ({
      results: batch.map(() => 1),
      failed: [{ index: 9, errorType: 'Unanswerable' }],
    }));
    const { output } = await runToCompletion(job, req(), {
      store: new MemoryJobStore(),
      executor: fast,
    });
    expect(output?.results).toHaveLength(0);
    expect(output?.failed).toHaveLength(4);
  });

  test('a pause lets the batch in flight finish and write; new calls wait for the resume', async () => {
    const store = new MemoryJobStore();
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    let reached: (signal: AbortSignal) => void = () => {};
    const atSecond = new Promise<AbortSignal>((r) => {
      reached = r;
    });
    const toy = toyScoring({
      onCall: (n, _call, signal) => {
        if (n !== 2) return undefined;
        reached(signal);
        return gate;
      },
    });
    const registry = createRegistry([toy.job]);
    const executor = new InProcessExecutor({
      store,
      registry,
      limiters: localLimiters({ toy: { inFlight: 1 } }),
      claimTtlMs: 30,
      ...fast,
    });
    const { run: created } = await startRun(
      { registry, store },
      { ...request(10), jobKey: toy.job.key },
    );
    const control = { store, clock: systemClock, events: executor.sink };
    await executor.start();
    await executor.submit(created.id);
    const inFlight = await atSecond;
    await pauseRun(control, created.id);
    // Several heartbeats pass (one every 10 ms): none aborts the call in flight.
    await new Promise((r) => setTimeout(r, 80));
    expect(inFlight.aborted).toBe(false);
    open();
    // The call lands and writes, the chunk yields, and nothing else is asked while paused.
    for (let i = 0; i < 200; i++) {
      const { steps } = await store.progress(created.id);
      if (steps[1]?.counts.done === 4 && steps[1]?.chunks.running === 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const paused = await store.progress(created.id);
    expect(paused.run.status).toBe('paused');
    expect(paused.steps[1]?.counts.done).toBe(4);
    expect(paused.run.spend.calls).toBe(2);
    expect(toy.calls).toHaveLength(2);
    await resumeRun(control, created.id);
    await executor.submit(created.id);
    for (let i = 0; i < 400; i++) {
      if ((await store.getRun(created.id)).status === 'completed') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    await executor.stop();
    const done = await store.progress(created.id);
    expect(done.run.status).toBe('completed');
    expect(done.steps[1]?.counts.done).toBe(10);
    // Each item asked once: the paused batch's write stood.
    expect(toy.calls.flatMap((c) => c.refs).sort()).toEqual(ids(10));
  });

  test('a cancel aborts the call in flight through ctx.signal, and what it spent is recorded', async () => {
    const store = new MemoryJobStore();
    let reached: (signal: AbortSignal) => void = () => {};
    const atFirst = new Promise<AbortSignal>((r) => {
      reached = r;
    });
    const job = spendJob('toy.cancel-spend', async (_batch, signal) => {
      reached(signal);
      try {
        await hang(signal);
      } catch (err) {
        throw withSpend(err, { inputTokens: 7, costUsd: 0.3 });
      }
      return [];
    });
    const registry = createRegistry([job]);
    const executor = new InProcessExecutor({
      store,
      registry,
      limiters: localLimiters({ toy: { inFlight: 1 } }),
      claimTtlMs: 30,
      ...fast,
    });
    const { run: created } = await startRun(
      { registry, store },
      { ...req(), jobKey: job.key },
    );
    await executor.start();
    await executor.submit(created.id);
    const inFlight = await atFirst;
    await cancelRun(
      { store, clock: systemClock, events: executor.sink },
      created.id,
    );
    await new Promise((r) =>
      inFlight.addEventListener('abort', r, { once: true }),
    );
    await executor.stop();
    const { run, steps } = await store.progress(created.id);
    expect(run.status).toBe('canceled');
    expect(run.spend).toEqual({ calls: 1, inputTokens: 7, costUsd: 0.3 });
    // Counts never move after the run ended.
    expect(steps[0]?.counts.done).toBe(0);
  });

  test('a call that ignores the signal and lands after a cancel records its spend; its items stay pending and its results stay cached', async () => {
    const store = new MemoryJobStore();
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    let reached: () => void = () => {};
    const atFirst = new Promise<void>((r) => {
      reached = r;
    });
    const job = spendJob('toy.late-landing', async (batch) => {
      reached();
      await gate;
      return { results: batch.map(() => 1), spend: { costUsd: 0.4 } };
    });
    const registry = createRegistry([job]);
    const executor = new InProcessExecutor({
      store,
      registry,
      limiters: localLimiters({ toy: { inFlight: 1 } }),
      claimTtlMs: 30,
      ...fast,
    });
    const { run: created } = await startRun(
      { registry, store },
      { ...req(), jobKey: job.key },
    );
    await executor.start();
    await executor.submit(created.id);
    await atFirst;
    await cancelRun(
      { store, clock: systemClock, events: executor.sink },
      created.id,
    );
    open();
    await executor.stop();
    const { run, steps } = await store.progress(created.id);
    expect(run.status).toBe('canceled');
    expect(run.spend).toEqual({ calls: 1, inputTokens: 0, costUsd: 0.4 });
    expect(steps[0]?.counts.done).toBe(0);
    expect(
      (await store.items(created.id, 'ask')).every(
        (i) => i.status === 'pending',
      ),
    ).toBe(true);
    const cached = await store.itemResults(`${job.key}/ask`, TENANT, [
      'm1:o000',
      'm1:o003',
    ]);
    expect(cached.size).toBe(2);
  });
});

describe('gates and waits (t41)', () => {
  const req = (n = 4) => ({
    input: {},
    tenantId: TENANT,
    trigger: 'eval' as const,
    requestedBy: null,
    budget: { maxItems: n },
  });
  const quickPoll = { initialMs: 5, maxMs: 20 };

  test('a closed gate parks the step before it starts; the run carries on once a poll finds it open', async () => {
    let open = false;
    let reads = 0;
    const aiProcessing = gate({
      name: 'ai-processing',
      isOpen: () => {
        reads++;
        // Open on the third read: the start, one poll, then open.
        if (reads >= 3) open = true;
        return open;
      },
      poll: quickPoll,
    });
    const asked: string[] = [];
    const job = defineJob({
      key: 'toy.gated-map',
      input: z.object({}),
      output: z.object({
        results: z.array(z.unknown()),
        failed: z.array(z.unknown()),
      }),
      steps: (s) =>
        s.add(
          'ask',
          mapStep({
            items: () => ids(4),
            key: (r) => `g1:${r}`,
            run: async (batch) => {
              asked.push(...batch.map((b) => b.ref));
              return batch.map(() => 1);
            },
            batch: { max: 2 },
            limiter: 'toy',
            gates: [aiProcessing],
          }),
        ),
    });
    const sink = recordingSink();
    const clock = fakeClock();
    const { run, output } = await runToCompletion(job, req(), {
      store: new MemoryJobStore({ now: clock.now }),
      clock,
      sinks: [sink],
      executor: fast,
    });
    expect(run.status).toBe('completed');
    expect(output?.results).toHaveLength(4);
    expect(asked.sort()).toEqual(ids(4));
    expect(
      sink.events.filter(
        (e) => e.type === 'step.waiting' || e.type === 'step.woke',
      ),
    ).toMatchObject([
      { type: 'step.waiting', waitKind: 'gate', waitName: 'ai-processing' },
      { type: 'step.woke', waitKind: 'gate', waitName: 'ai-processing' },
    ]);
  });

  test('a batch that finds its gate closed fails nothing: its items stay pending, its spend is kept, the step waits', async () => {
    let open = true;
    let calls = 0;
    const aiProcessing = gate({
      name: 'ai-processing',
      isOpen: () => {
        if (open) return true;
        // Closed for one read, then the switch is back on.
        open = true;
        return false;
      },
      poll: quickPoll,
    });
    const job = defineJob({
      key: 'toy.gate-closes',
      input: z.object({}),
      output: z.object({
        results: z.array(z.unknown()),
        failed: z.array(z.unknown()),
      }),
      steps: (s) =>
        s.add(
          'ask',
          mapStep({
            items: () => ids(4),
            key: (r) => `g2:${r}`,
            run: async (batch) => {
              calls++;
              if (calls === 1) {
                open = false;
                throw withSpend(new GateClosedError('ai-processing'), {
                  costUsd: 0.2,
                });
              }
              return { results: batch.map(() => 1), spend: { costUsd: 0.1 } };
            },
            batch: { max: 4 },
            limiter: 'toy',
            gates: [aiProcessing],
          }),
        ),
    });
    const sink = recordingSink();
    const clock = fakeClock();
    const { run, output } = await runToCompletion(job, req(), {
      store: new MemoryJobStore({ now: clock.now }),
      clock,
      sinks: [sink],
      executor: fast,
    });
    expect(run.status).toBe('completed');
    expect(output?.results).toHaveLength(4);
    expect(output?.failed).toHaveLength(0);
    expect(calls).toBe(2);
    expect(run.spend.costUsd).toBeCloseTo(0.3, 9);
    expect(
      sink.types((t) => t === 'item.failed' || t === 'step.retried'),
    ).toEqual([]);
    expect(sink.types((t) => t === 'step.waiting')).toEqual(['step.waiting']);
  });

  test("GateClosedError for a gate the step doesn't declare is a definition error, never a wait", async () => {
    const plain = defineJob({
      key: 'toy.undeclared-gate-step',
      input: z.object({}),
      output: z.void(),
      steps: (s) =>
        s.add(
          'go',
          step({
            run: () => {
              throw new GateClosedError('not-declared');
            },
          }),
        ),
    });
    const mapped = defineJob({
      key: 'toy.undeclared-gate-map',
      input: z.object({}),
      output: z.object({
        results: z.array(z.unknown()),
        failed: z.array(z.unknown()),
      }),
      steps: (s) =>
        s.add(
          'ask',
          mapStep({
            items: () => ids(2),
            key: (r) => `ug:${r}`,
            run: async () => {
              throw new GateClosedError('not-declared');
            },
            batch: { max: 2 },
            limiter: 'toy',
          }),
        ),
    });
    const clock = fakeClock();
    const sink = recordingSink();
    const store = new MemoryJobStore({ now: clock.now });
    const opts = { store, clock, sinks: [sink], executor: fast };
    // A plain step's fails its run; a map step's fails the chunk's items, each by the definition error's type.
    const single = await runToCompletion(plain, req(0), opts);
    expect(single.run.status).toBe('failed');
    expect(single.run.error?.type).toBe('JobDefinitionError');
    const map = await runToCompletion(mapped, req(2), opts);
    expect(map.output?.results).toEqual([]);
    expect(
      (map.output?.failed as { errorType: string }[]).map((f) => f.errorType),
    ).toEqual(['JobDefinitionError', 'JobDefinitionError']);
    expect(sink.types((t) => t === 'step.waiting')).toEqual([]);
  });

  test('a gate closed past its maxWaitMs fails the step', async () => {
    const never = gate({
      name: 'never-open',
      isOpen: () => false,
      poll: quickPoll,
      maxWaitMs: 50,
    });
    const job = defineJob({
      key: 'toy.gate-times-out',
      input: z.object({}),
      output: z.void(),
      steps: (s) => s.add('wait', waitFor({ gate: never })),
    });
    const clock = fakeClock();
    const { run } = await runToCompletion(job, req(0), {
      store: new MemoryJobStore({ now: clock.now }),
      clock,
      executor: fast,
    });
    expect(run.status).toBe('failed');
    expect(run.error?.type).toBe('GateTimedOutError');
  });

  test('a gate that throws on a later poll fails the step and the run (review #969)', async () => {
    let reads = 0;
    const flaky = gate({
      name: 'flaky',
      isOpen: () => {
        reads += 1;
        if (reads > 1) throw new Error('service down');
        return false;
      },
      poll: quickPoll,
    });
    const job = defineJob({
      key: 'toy.gate-throws-later',
      input: z.object({}),
      output: z.void(),
      steps: (s) => s.add('wait', waitFor({ gate: flaky })),
    });
    const clock = fakeClock();
    const store = new MemoryJobStore({ now: clock.now });
    const { run } = await runToCompletion(job, req(0), { store, clock, executor: fast });
    expect(reads).toBe(2);
    expect(run.status).toBe('failed');
    expect(run.error?.message).toBe('service down');
    expect((await store.stepStates(run.id)).find((s) => s.name === 'wait')?.status).toBe('failed');
  });

  test('openGate wakes a waiting run before its poll, and only its tenant', async () => {
    let open = false;
    const backfillDone = gate({
      name: 'backfill-done',
      isOpen: () => open,
      poll: { initialMs: 3_600_000, maxMs: 3_600_000 },
    });
    const job = defineJob({
      key: 'toy.wait-for',
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      steps: (s) =>
        s
          .add('wait', waitFor({ gate: backfillDone }))
          .add('after', step({ run: () => ({ done: true }) })),
    });
    const store = new MemoryJobStore();
    const registry = createRegistry([job]);
    const executor = new InProcessExecutor({ store, registry, ...fast });
    const { run: created } = await startRun(
      { registry, store },
      { ...req(0), jobKey: job.key },
    );
    await executor.start();
    await executor.submit(created.id);
    for (let i = 0; i < 200; i++) {
      if ((await store.getRun(created.id)).status === 'waiting') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await store.getRun(created.id)).status).toBe('waiting');
    expect(
      await openGate({ store, executor }, 'another-tenant', 'backfill-done'),
    ).toEqual([]);
    open = true;
    expect(await openGate({ store, executor }, TENANT, 'backfill-done')).toEqual([
      created.id,
    ]);
    for (let i = 0; i < 200; i++) {
      if ((await store.getRun(created.id)).status === 'completed') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    await executor.stop();
    const { run, steps } = await store.progress(created.id);
    expect(run.status).toBe('completed');
    expect(steps[0]?.wait).toMatchObject({
      kind: 'gate',
      name: 'backfill-done',
      wakeAt: null,
    });
  });

  test('a gate name is a code constant', () => {
    expect(() => gate({ name: 'Has Spaces', isOpen: () => true })).toThrow(
      JobDefinitionError,
    );
  });
});

describe('limiters per tenant (t11)', () => {
  /** Local limiters that record each bucket a call took and how many slots are held now. */
  const recording = () => {
    const inner = localLimiters({}, { fallback: { inFlight: 4 } });
    const taken: string[] = [];
    let held = 0;
    const limiters: Limiters = {
      get: (name, key) => {
        const l = inner.get(name, key);
        return {
          async acquire(cost, signal) {
            const p = await l.acquire(cost, signal);
            taken.push(key);
            held++;
            return {
              release(outcome) {
                held--;
                p.release(outcome);
              },
            };
          },
        };
      },
    };
    return { limiters, taken, held: () => held };
  };
  const req = (tenantId: string) => ({
    input: {},
    tenantId,
    trigger: 'eval' as const,
    requestedBy: null,
    budget: { maxItems: 10 },
  });

  test("a map step's call takes each bucket sorted by name, a tenant's by its key", async () => {
    const r = recording();
    const job = defineJob({
      key: 'toy.per-tenant',
      input: z.object({}),
      output: z.object({ n: z.number() }),
      steps: (s) =>
        s
          .add(
            'judge',
            mapStep({
              items: () => ['a'],
              key: (ref) => ref,
              run: async (batch) => batch.map(() => 1),
              batch: { max: 1 },
              limiter: ['gemini', { name: 'decisions', per: 'tenant' }],
            }),
          )
          .add('n', step({ run: ({ judge }) => judge.results.length }))
          .add('out', step({ run: ({ n }) => ({ n }) })),
    });
    const outcome = await runToCompletion(job, req('tenant-7'), {
      store: new MemoryJobStore(),
      limiters: r.limiters,
      executor: fast,
    });
    expect(outcome.run.status).toBe('completed');
    expect(r.taken).toEqual(['decisions:tenant-7', 'gemini']);
    expect(r.held()).toBe(0);
  });

  test('a plain step holds its limiter for its whole run, and gives it back when it throws', async () => {
    const r = recording();
    const heldDuring: number[] = [];
    let calls = 0;
    const job = defineJob({
      key: 'toy.plain-limited',
      input: z.object({}),
      output: z.number(),
      steps: (s) =>
        s.add(
          'band',
          step({
            limiter: { name: 'bands', per: 'tenant' },
            retry: {
              initialIntervalMs: 1,
              backoffCoefficient: 1,
              maximumAttempts: 2,
            },
            run: () => {
              heldDuring.push(r.held());
              if (++calls === 1) throw new Error('transient');
              return 3;
            },
          }),
        ),
    });
    const outcome = await runToCompletion(job, req('tenant-9'), {
      store: new MemoryJobStore(),
      limiters: r.limiters,
      executor: fast,
    });
    expect(outcome.output).toBe(3);
    expect(heldDuring).toEqual([1, 1]);
    expect(r.taken).toEqual(['bands:tenant-9', 'bands:tenant-9']);
    expect(r.held()).toBe(0);
  });
});

describe('cacheScope', () => {
  const Verdict = z.object({ yes: z.boolean() });
  const judged = (
    key: string,
    scopes: { a?: string; b?: string },
    calls: Record<string, number>,
    schemas: {
      a?: z.ZodType<{ yes: boolean }>;
      b?: z.ZodType<{ yes: boolean }>;
    } = {},
  ) => {
    const judge = (name: 'a' | 'b') =>
      mapStep({
        items: () => ids(3),
        key: (r) => `std-1:${r}`,
        run: async (batch) => {
          calls[name] = (calls[name] ?? 0) + batch.length;
          return batch.map((b) => ({ yes: scoreOf(b.ref) > 0.5 }));
        },
        result: schemas[name] ?? Verdict,
        batch: { max: 3 },
        limiter: 'toy',
        cacheScope: scopes[name],
      });
    return defineJob({
      key,
      input: z.object({}),
      output: z.unknown(),
      steps: (s) => s.add('a', judge('a')).add('b', judge('b')),
    });
  };
  const go = (job: ReturnType<typeof judged>, store: MemoryJobStore) =>
    runToCompletion(
      job,
      {
        input: {},
        tenantId: TENANT,
        trigger: 'eval',
        requestedBy: null,
        budget: { maxItems: 100, maxUsd: 1 },
      },
      { store, executor: fast },
    );

  test('two steps sharing a scope answer each other from one cache', async () => {
    const calls: Record<string, number> = {};
    const store = new MemoryJobStore();
    const { run: done, steps } = await go(
      judged('toy.shared', { a: 'toy-judge', b: 'toy-judge' }, calls),
      store,
    );
    expect(done.status).toBe('completed');
    expect(calls).toEqual({ a: 3 });
    expect(steps[1]?.counts).toMatchObject({ cached: 3 });
    expect(
      (await store.itemResults('toy-judge', TENANT, ['std-1:o000'])).size,
    ).toBe(1);
    expect(
      (await store.itemResults('toy.shared/a', TENANT, ['std-1:o000'])).size,
    ).toBe(0);
  });

  test('another job naming the scope reads it too', async () => {
    const calls: Record<string, number> = {};
    const store = new MemoryJobStore();
    await go(
      judged('toy.shared', { a: 'toy-judge', b: 'toy-judge' }, calls),
      store,
    );
    const later: Record<string, number> = {};
    const { steps } = await go(
      judged('toy.shared-2', { a: 'toy-judge' }, later),
      store,
    );
    expect(later).toEqual({ b: 3 });
    expect(steps[0]?.counts).toMatchObject({ cached: 3 });
  });

  test('without one, each step keeps its own cache', async () => {
    const calls: Record<string, number> = {};
    const store = new MemoryJobStore();
    const { steps } = await go(judged('toy.own', {}, calls), store);
    expect(calls).toEqual({ a: 3, b: 3 });
    expect(steps[1]?.counts).toMatchObject({ done: 3 });
    expect(
      (await store.itemResults('toy.own/b', TENANT, ['std-1:o000'])).size,
    ).toBe(1);
  });

  test('steps sharing a scope declare one result schema object, within a job and across jobs', () => {
    const Same = z.object({ yes: z.boolean() });
    expect(() =>
      judged('toy.clash', { a: 'toy-judge', b: 'toy-judge' }, {}, { b: Same }),
    ).toThrow(JobDefinitionError);
    expect(() =>
      createRegistry([
        judged('toy.one', { a: 'toy-judge' }, {}),
        judged('toy.two', { a: 'toy-judge' }, {}, { a: Same }),
      ]),
    ).toThrow(/different result schemas/);
    expect(() =>
      createRegistry([
        judged('toy.one', { a: 'toy-judge' }, {}),
        judged('toy.two', { b: 'toy-judge' }, {}),
      ]),
    ).not.toThrow();
  });

  test("a scope is a name without '/', for a step the store keeps with a declared result schema", () => {
    const base = {
      items: () => ids(1),
      key: (r: string) => r,
      run: async (batch: readonly unknown[]) =>
        batch.map(() => ({ yes: true })),
      batch: { max: 1 },
      limiter: 'toy',
    };
    expect(() =>
      mapStep({ ...base, result: Verdict, cacheScope: 'toy.shared/a' }),
    ).toThrow(JobDefinitionError);
    expect(() => mapStep({ ...base, result: Verdict, cacheScope: '' })).toThrow(
      JobDefinitionError,
    );
    expect(() => mapStep({ ...base, cacheScope: 'toy-judge' })).toThrow(
      /declares its result schema/,
    );
    expect(() =>
      mapStep({
        ...base,
        result: Verdict,
        results: memoryResultRecorder<{ yes: boolean }>(),
        cacheScope: 'toy-judge',
      }),
    ).toThrow(/only the store's cache/);
  });

  test('the scope enters the definition version only when set', () => {
    const own = judged('toy.v', {}, {});
    const shared = judged('toy.v', { a: 'toy-judge' }, {});
    expect(shared.version).not.toBe(own.version);
    expect(judged('toy.v', {}, {}).version).toBe(own.version);
  });
});

describe("a run's subject", () => {
  const about = (
    subject?: (input: { id: string }) => { kind: string; id: string } | null,
  ) =>
    defineJob({
      key: 'toy.about',
      input: z.object({ id: z.string() }),
      output: z.number(),
      steps: (s) => s.add('one', step({ run: () => 1 })),
      subject,
    });
  const start = (job: ReturnType<typeof about>, input: object) =>
    startRun({ registry: createRegistry([job]), store: new MemoryJobStore() }, {
      jobKey: job.key,
      input,
      tenantId: TENANT,
      trigger: 'eval',
      requestedBy: null,
      budget: { maxItems: 1 },
      // A caller's own subject is never taken.
      subject: { kind: 'forged', id: 'x' },
    } as RunRequest<unknown>);

  test('the job names it from its input at start; a caller cannot', async () => {
    const { run } = await start(
      about((i) => ({ kind: 'document', id: i.id })),
      { id: 'iv-7' },
    );
    expect(run.subject).toEqual({ kind: 'document', id: 'iv-7' });
    const { run: plain } = await start(about(), { id: 'iv-7' });
    expect(plain.subject).toBeNull();
  });

  test('a subject with an empty or overlong part is the definition’s error', async () => {
    await expect(
      start(
        about((i) => ({ kind: '', id: i.id })),
        { id: 'iv-7' },
      ),
    ).rejects.toThrow(JobDefinitionError);
    await expect(
      start(
        about(() => ({ kind: 'k', id: 'x'.repeat(256) })),
        { id: 'a' },
      ),
    ).rejects.toThrow(JobDefinitionError);
  });
});

describe('a refresh run', () => {
  let answer = 'old';
  const asked = defineJob({
    key: 'toy.refresh',
    input: z.object({}),
    output: z.unknown(),
    steps: (s) =>
      s.add(
        'ask',
        mapStep({
          items: () => ids(2),
          key: (r) => `std-1:${r}`,
          run: async (batch) => batch.map(() => answer),
          result: z.string(),
          batch: { max: 2 },
          limiter: 'toy',
        }),
      ),
  });
  const go = (store: MemoryJobStore, cache?: 'read-write' | 'refresh') =>
    runToCompletion(
      asked,
      {
        input: {},
        tenantId: TENANT,
        trigger: 'eval',
        requestedBy: null,
        budget: { maxItems: 10, maxUsd: 1 },
        ...(cache ? { cache } : {}),
      },
      { store, executor: fast },
    );

  test('reads back its own fresh answers, not the ones it re-asked over', async () => {
    const store = new MemoryJobStore();
    answer = 'old';
    await go(store);
    answer = 'new';
    const { output } = await go(store, 'refresh');
    expect(JSON.stringify(output)).toContain('new');
    expect(JSON.stringify(output)).not.toContain('old');
  });
});

describe("a job's cache mode (cacheFor)", () => {
  const forced = defineJob({
    key: 'toy.forced',
    input: z.object({ force: z.boolean() }),
    output: z.number(),
    steps: (s) => s.add('one', step({ run: () => 1 })),
    cacheFor: (input) => (input.force ? 'refresh' : 'read-write'),
  });
  const start = (input: { force: boolean }, cache?: 'read-write' | 'refresh') =>
    startRun(
      { registry: createRegistry([forced]), store: new MemoryJobStore() },
      {
        jobKey: forced.key,
        input,
        tenantId: TENANT,
        trigger: 'eval',
        requestedBy: null,
        budget: { maxItems: 1 },
        ...(cache ? { cache } : {}),
      },
    );

  test('the job picks refresh from its input; the request overrides it; the default is read-write', async () => {
    expect((await start({ force: true })).run.cache).toBe('refresh');
    expect((await start({ force: false })).run.cache).toBe('read-write');
    expect((await start({ force: true }, 'read-write')).run.cache).toBe(
      'read-write',
    );
    expect((await start({ force: false }, 'refresh')).run.cache).toBe(
      'refresh',
    );
    expect((await start({ force: true })).run.jobVersion).toBe(forced.version);
  });
});
