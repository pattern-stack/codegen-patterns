import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { runToCompletion } from '../adapters/in-process-executor.ts';
import { MemoryJobStore } from '../adapters/memory-store.ts';
import { defineJob } from '../define/define-job.ts';
import { createRegistry } from '../define/registry.ts';
import { step, waitFor } from '../define/step.ts';
import { signalAuthorityOf, signalRun } from '../engine/signals.ts';
import { cancelRun, pauseRun, resumeRun, startRun } from '../engine/start-run.ts';
import {
  InputRefusedError,
  JobDefinitionError,
  SignalRefusedError,
} from '../model/errors.ts';
import { fakeClock } from '../testing/fake-clock.ts';
import { recordingSink } from '../testing/recording-sink.ts';
import { replayContract } from '../testing/replay.ts';

const TENANT = 'tenant-signals';
const fast = { pollMs: 1 };
const request = (dedupeKey?: string) => ({
  input: { versions: ['v1', 'v2'] },
  tenantId: TENANT,
  trigger: 'eval' as const,
  requestedBy: null,
  budget: { maxItems: 10 },
  ...(dedupeKey ? { dedupeKey } : {}),
});

const Publish = z.object({ publish: z.array(z.string()) });

/** Proposes versions, waits for a person to choose some, then publishes the chosen ones. */
const approvalJob = (timeout?: {
  afterMs: number;
  fallback: 'fail' | { value: { publish: string[] } };
}) =>
  defineJob({
    key: 'toy.approval',
    input: z.object({ versions: z.array(z.string()) }),
    output: z.object({ published: z.array(z.string()) }),
    authority: { start: 'admin', dryRun: 'tenant-wide' },
    steps: (s) =>
      s
        .add('propose', step({ run: ({ input }) => input.versions }))
        .add(
          'approval',
          waitFor({
            signal: 'approve',
            value: Publish,
            description: 'Choose the versions to publish',
            accept: ({ publish }, { propose }) => {
              if (!publish.every((id) => propose.includes(id)))
                throw new InputRefusedError(
                  'not_proposed',
                  'Only a proposed version can be published',
                );
            },
            timeout,
          }),
        )
        .add(
          'publish',
          step({ run: ({ approval }) => ({ published: approval.publish }) }),
        ),
  });

const waitingRun = async (
  job: ReturnType<typeof approvalJob>,
  store: MemoryJobStore,
  clock = fakeClock(),
) => {
  const outcome = await runToCompletion(job, request('approval'), {
    store,
    clock,
    executor: fast,
  });
  return { outcome, clock };
};

describe('signals', () => {
  test('a wait step parks its run until a signal its schema and accept take; the value is the step output', async () => {
    const job = approvalJob();
    const store = new MemoryJobStore();
    const sink = recordingSink();
    const { outcome, clock } = await waitingRun(job, store);
    expect(outcome.run.status).toBe('waiting');
    const waiting = outcome.steps.find((s) => s.name === 'approval');
    expect(waiting).toMatchObject({
      status: 'waiting',
      kind: 'wait',
      attempts: 0,
      wait: { kind: 'signal', name: 'approve', wakeAt: null },
    });
    const deps = {
      store,
      registry: createRegistry([job]),
      clock,
      events: sink,
    };
    const send = (value: unknown, signal = 'approve', step = 'approval') =>
      signalRun(deps, {
        runId: outcome.run.id,
        step,
        signal,
        value,
        by: 'user-1',
      });
    // The value's schema: each failing path and code, never the value.
    const invalid = await send({ publish: 'v1' }).catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(SignalRefusedError);
    expect(invalid).toMatchObject({
      code: 'signal_value_invalid',
      issues: [{ path: 'publish', code: 'invalid_type' }],
    });
    // The step's accept, with its own code.
    await expect(send({ publish: ['v9'] })).rejects.toMatchObject({
      name: 'InputRefusedError',
      code: 'not_proposed',
    });
    // Another signal, or a step that isn't a wait for it.
    await expect(send({ publish: [] }, 'reject')).rejects.toMatchObject({
      code: 'wait_not_open',
    });
    await expect(
      send({ publish: [] }, 'approve', 'propose'),
    ).rejects.toMatchObject({ code: 'wait_not_open' });
    expect((await store.getRun(outcome.run.id)).status).toBe('waiting');

    const { run } = await send({ publish: ['v2'] });
    expect(run.status).toBe('running');
    // The first signal wins.
    await expect(send({ publish: ['v1'] })).rejects.toMatchObject({
      code: 'wait_not_open',
    });
    expect(sink.events.map((e) => e.type)).toEqual(['step.signaled']);
    expect(sink.events[0]).toMatchObject({
      waitName: 'approve',
      byTimeout: false,
    });

    const done = await runToCompletion(job, request('approval'), {
      store,
      clock,
      executor: fast,
    });
    expect(done.run.id).toBe(outcome.run.id);
    expect(done.output).toEqual({ published: ['v2'] });
    expect(done.steps.find((s) => s.name === 'approval')).toMatchObject({
      status: 'completed',
      settledBy: 'user-1',
    });
  });

  test('scripted signals answer a wait in runToCompletion', async () => {
    const outcome = await runToCompletion(approvalJob(), request(), {
      store: new MemoryJobStore(),
      signals: ({ step }) =>
        step === 'approval' ? { publish: ['v1'] } : undefined,
      executor: fast,
    });
    expect(outcome.run.status).toBe('completed');
    expect(outcome.output).toEqual({ published: ['v1'] });
  });

  test("a timeout fails the step, or settles it with its value as no one's signal", async () => {
    const thens: ('fail' | { value: { publish: string[] } })[] = [
      'fail',
      { value: { publish: ['v1'] } },
    ];
    for (const then of thens) {
      const job = approvalJob({ afterMs: 60_000, fallback: then });
      const store = new MemoryJobStore();
      const clock = fakeClock();
      const sink = recordingSink();
      const running = runToCompletion(job, request(), {
        store,
        clock,
        sinks: [sink],
        executor: fast,
      });
      for (let i = 0; i < 500; i++) {
        if (sink.events.some((e) => e.type === 'step.waiting')) break;
        await new Promise((r) => setTimeout(r, 2));
      }
      const parked = sink.events.find((e) => e.type === 'step.waiting');
      expect(parked).toMatchObject({ waitKind: 'signal', waitName: 'approve' });
      clock.advance(60_001);
      const outcome = await running;
      const approval = outcome.steps.find((s) => s.name === 'approval');
      if (then === 'fail') {
        expect(outcome.run.status).toBe('failed');
        expect(approval?.error?.type).toBe('WaitTimedOutError');
      } else {
        expect(outcome.output).toEqual({ published: ['v1'] });
        expect(approval).toMatchObject({
          status: 'completed',
          settledBy: null,
        });
        expect(
          sink.events.find((e) => e.type === 'step.signaled'),
        ).toMatchObject({ byTimeout: true });
      }
    }
  });

  test('a signal to a paused run is recorded; the resume carries on from it', async () => {
    const job = approvalJob();
    const store = new MemoryJobStore();
    const { outcome, clock } = await waitingRun(job, store);
    const registry = createRegistry([job]);
    await pauseRun({ store, clock }, outcome.run.id);
    const { run } = await signalRun(
      { store, registry, clock, events: recordingSink() },
      {
        runId: outcome.run.id,
        step: 'approval',
        signal: 'approve',
        value: { publish: ['v1'] },
        by: null,
      },
    );
    expect(run.status).toBe('paused');
    await resumeRun({ store, clock }, outcome.run.id);
    const done = await runToCompletion(job, request('approval'), {
      store,
      clock,
      executor: fast,
    });
    expect(done.output).toEqual({ published: ['v1'] });
  });

  test('a signal for a run canceled while it waited is wait_not_open, and records nothing (review #969)', async () => {
    const job = approvalJob();
    const store = new MemoryJobStore();
    const { outcome, clock } = await waitingRun(job, store);
    const registry = createRegistry([job]);
    const sink = recordingSink();
    await cancelRun({ store, clock }, outcome.run.id);
    await expect(
      signalRun(
        { store, registry, clock, events: sink },
        { runId: outcome.run.id, step: 'approval', signal: 'approve', value: { publish: ['v1'] }, by: null },
      ),
    ).rejects.toMatchObject({ code: 'wait_not_open' });
    expect(sink.events.map((e) => e.type)).not.toContain('step.signaled');
    expect(await store.stepOutput(outcome.run.id, 'approval')).toBeUndefined();
  });

  test("who may send it: the wait's own level, else the level that started the run", async () => {
    const job = approvalJob();
    const store = new MemoryJobStore();
    const registry = createRegistry([job]);
    const real = (
      await startRun({ registry, store }, { ...request(), jobKey: job.key })
    ).run;
    const dry = (
      await startRun(
        { registry, store },
        { ...request(), jobKey: job.key, dryRun: true },
      )
    ).run;
    expect(signalAuthorityOf(job, real, 'approval')).toBe('admin');
    expect(signalAuthorityOf(job, dry, 'approval')).toBe('tenant-wide');
    const own = defineJob({
      key: 'toy.own-level',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      steps: (s) =>
        s.add(
          'approval',
          waitFor({
            signal: 'approve',
            value: z.object({ ok: z.boolean() }),
            authority: 'member',
          }),
        ),
    });
    expect(signalAuthorityOf(own, real, 'approval')).toBe('member');
  });

  test("a signal's facts are checked at definition time, and its value schema and timeout are in the version", () => {
    const wait = (signal: string, fallback?: 'fail' | { value: unknown }) =>
      waitFor({
        signal,
        value: z.object({ ok: z.boolean() }),
        timeout: fallback
          ? { afterMs: 1_000, fallback: fallback as 'fail' }
          : undefined,
      });
    expect(() => wait('Has Spaces')).toThrow(JobDefinitionError);
    expect(() => wait('approve', { value: { ok: 'yes' } })).toThrow(
      'does not match its value schema',
    );
    const version = (value: z.ZodType) =>
      defineJob({
        key: 'toy.version',
        input: z.object({}),
        output: z.unknown(),
        steps: (s) => s.add('approval', waitFor({ signal: 'approve', value })),
      }).version;
    expect(version(z.object({ a: z.string() }))).not.toBe(
      version(z.object({ a: z.number() })),
    );
    expect(() =>
      defineJob({
        key: 'toy.reserved-output-of',
        input: z.object({}),
        output: z.number(),
        // @ts-expect-error outputOf is the context's own
        steps: (s) => s.add('outputOf', step({ run: () => 1 })),
      }),
    ).toThrow('may not be named outputOf');
  });
});

describe('ctx.outputOf', () => {
  const calibrate = defineJob({
    key: 'toy.calibrate',
    input: z.object({ n: z.number() }),
    output: z.object({ line: z.number() }),
    steps: (s) =>
      s.add('fit', step({ run: ({ input }) => ({ line: input.n * 2 }) })),
  });
  const publish = defineJob({
    key: 'toy.publish',
    input: z.object({ tunedBy: z.string() }),
    output: z.object({ published: z.number() }),
    admit: async ({ tunedBy }, { outputOf }) => {
      await outputOf(calibrate, tunedBy);
    },
    steps: (s) =>
      s.add(
        'publish',
        step({
          run: async ({ input, outputOf }) => {
            const { line } = await outputOf(calibrate, input.tunedBy);
            return { published: line };
          },
        }),
      ),
  });
  const base = {
    trigger: 'eval' as const,
    requestedBy: null,
    budget: { maxItems: 10 },
  };

  test("a step reads a completed run's output, typed; admit refuses a bad reference before a run exists", async () => {
    const store = new MemoryJobStore();
    const tuned = await runToCompletion(
      calibrate,
      { ...base, input: { n: 21 }, tenantId: TENANT },
      { store, executor: fast },
    );
    const published = await runToCompletion(
      publish,
      { ...base, input: { tunedBy: tuned.run.id }, tenantId: TENANT },
      { store, executor: fast },
    );
    expect(published.output).toEqual({ published: 42 });

    const registry = createRegistry([calibrate, publish]);
    const refused = async (tunedBy: string, tenantId = TENANT) =>
      startRun(
        { registry, store },
        { ...base, jobKey: publish.key, input: { tunedBy }, tenantId },
      ).catch((e: unknown) => e);
    // Missing, and another tenant's: the same code, never told apart.
    expect(await refused('no-such-run')).toMatchObject({
      code: 'run_not_found',
    });
    expect(await refused(tuned.run.id, 'tenant-other')).toMatchObject({
      code: 'run_not_found',
    });
    expect(await refused(published.run.id)).toMatchObject({
      code: 'run_wrong_job',
    });
    const pending = await startRun(
      { registry, store },
      { ...base, jobKey: calibrate.key, input: { n: 1 }, tenantId: TENANT },
    );
    expect(await refused(pending.run.id)).toMatchObject({
      code: 'run_not_completed',
    });
    expect(
      await store.listRuns({
        tenantId: TENANT,
        jobKey: publish.key,
        limit: 10,
      }),
    ).toHaveLength(1);
  });

  test("an output its job's current schema refuses is run_output_unreadable, and fails the step at once", async () => {
    const store = new MemoryJobStore();
    const tuned = await runToCompletion(
      calibrate,
      { ...base, input: { n: 1 }, tenantId: TENANT },
      { store, executor: fast },
    );
    // The same job, its output shape changed since the run.
    const changed = defineJob({
      key: calibrate.key,
      input: z.object({ n: z.number() }),
      output: z.object({ line: z.string() }),
      steps: (s) => s.add('fit', step({ run: () => ({ line: 'x' }) })),
    });
    let attempts = 0;
    const reader = defineJob({
      key: 'toy.reader',
      input: z.object({ ref: z.string() }),
      output: z.object({ line: z.string() }),
      steps: (s) =>
        s.add(
          'read',
          step({
            run: ({ input, outputOf }) => {
              attempts++;
              return outputOf(changed, input.ref);
            },
          }),
        ),
    });
    const outcome = await runToCompletion(
      reader,
      { ...base, input: { ref: tuned.run.id }, tenantId: TENANT },
      { store, executor: fast },
    );
    expect(outcome.run.status).toBe('failed');
    expect(outcome.steps[0]?.error?.type).toBe('InputRefusedError');
    expect(outcome.steps[0]?.error?.message).toContain('no longer matches');
    expect(attempts).toBe(1);
  });
});

for (const c of replayContract({
  name: 'toy.approval',
  job: approvalJob(),
  request: request(),
  signals: { approval: { publish: ['v2'] } },
}))
  test(c.name, c.run, 30_000);
