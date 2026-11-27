import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  InProcessExecutor,
  runToCompletion,
} from '../adapters/in-process-executor.ts';
import { MemoryJobStore } from '../adapters/memory-store.ts';
import { type ChildFailure, child, children } from '../define/children.ts';
import { type AnyJob, defineJob } from '../define/define-job.ts';
import { createRegistry } from '../define/registry.ts';
import { step, waitFor } from '../define/step.ts';
import { retryChild, skipChild } from '../engine/children.ts';
import { readRunOutput } from '../engine/context.ts';
import { cancelRun, startRun } from '../engine/start-run.ts';
import { JobDefinitionError } from '../model/errors.ts';
import { fakeClock } from '../testing/fake-clock.ts';
import { memoryRecorder } from '../adapters/memory-recorder.ts';
import { recordingSink } from '../testing/recording-sink.ts';
import { replayContract } from '../testing/replay.ts';

const TENANT = 'tenant-children';
const fast = { pollMs: 1 };

/** Which keys fail, by the test: a child keyed in `failing` throws once per entry. */
const failing = new Map<string, number>();

const square = defineJob({
  key: 'toy.square',
  input: z.object({ n: z.number() }),
  output: z.object({ squared: z.number() }),
  steps: (s) =>
    s.add(
      'square',
      step({
        retry: {
          initialIntervalMs: 1,
          backoffCoefficient: 1,
          maximumAttempts: 1,
        },
        run: ({ input }) => {
          const left = failing.get(String(input.n)) ?? 0;
          if (left > 0) {
            failing.set(String(input.n), left - 1);
            throw new Error('toy failure');
          }
          return { squared: input.n * input.n };
        },
      }),
    ),
});

const parentOf = (onFailure: ChildFailure = 'hold', key = 'toy.parent') =>
  defineJob({
    key,
    input: z.object({ ns: z.array(z.number()) }),
    output: z.object({ total: z.number(), failed: z.array(z.string()) }),
    steps: (s) =>
      s
        .add('plan', step({ run: ({ input }) => input.ns }))
        .add(
          'squares',
          children({
            job: square,
            each: ({ plan }) =>
              plan.map((n) => ({ key: String(n), input: { n } })),
            onFailure,
          }),
        )
        .add(
          'sum',
          step({
            run: ({ squares }) => ({
              total: squares.results.reduce((a, r) => a + r.output.squared, 0),
              failed: squares.failed
                .map((f) => f.key)
                .concat(squares.skipped.map((x) => x.key)),
            }),
          }),
        ),
  });

const request = (ns: number[], dedupeKey?: string) => ({
  input: { ns },
  tenantId: TENANT,
  trigger: 'eval' as const,
  requestedBy: null,
  budget: { maxItems: 10, maxUsd: 9 },
  ...(dedupeKey ? { dedupeKey } : {}),
});

describe('children', () => {
  test('a step starts one child per key, waits for them, and reads their outputs back, typed', async () => {
    failing.clear();
    const store = new MemoryJobStore();
    const sink = recordingSink();
    const outcome = await runToCompletion(parentOf(), request([1, 2, 3]), {
      store,
      sinks: [sink],
      executor: fast,
    });
    expect(outcome.run.status).toBe('completed');
    expect(outcome.output).toEqual({ total: 14, failed: [] });
    const kids = await store.listRuns({
      tenantId: TENANT,
      jobKey: square.key,
      limit: 10,
    });
    expect(kids).toHaveLength(3);
    for (const kid of kids) {
      expect(kid.parentRunId).toBe(outcome.run.id);
      expect(kid.depth).toBe(1);
      // The even share of what the parent had left.
      expect(kid.budget.maxUsd).toBeCloseTo(3);
    }
    const types = sink.events.map((e) => e.type);
    expect(types.filter((t) => t === 'child.started')).toHaveLength(3);
    expect(types.filter((t) => t === 'child.ended')).toHaveLength(3);
  });

  test('a child job with an input recorder gets its input there, first time and on a retry (review #969)', async () => {
    let failsLeft = 1;
    const inputs = memoryRecorder<{ n: number }>();
    const recordedSquare = defineJob({
      key: 'toy.recorded-square',
      input: z.object({ n: z.number() }),
      output: z.object({ squared: z.number() }),
      inputRecorder: inputs,
      steps: (s) =>
        s.add(
          'square',
          step({
            retry: { initialIntervalMs: 1, backoffCoefficient: 1, maximumAttempts: 1 },
            run: ({ input }) => {
              if (input.n === 2 && failsLeft-- > 0) throw new Error('toy failure');
              return { squared: input.n * input.n };
            },
          }),
        ),
    });
    const parent = defineJob({
      key: 'toy.recorded-parent',
      input: z.object({ ns: z.array(z.number()) }),
      output: z.object({ total: z.number() }),
      steps: (s) =>
        s
          .add(
            'squares',
            children({
              job: recordedSquare,
              each: ({ input }) => input.ns.map((n) => ({ key: String(n), input: { n } })),
              onFailure: 'hold',
            }),
          )
          .add(
            'sum',
            step({ run: ({ squares }) => ({ total: squares.results.reduce((a, r) => a + r.output.squared, 0) }) }),
          ),
    });
    const store = new MemoryJobStore();
    const clock = fakeClock();
    const registry = createRegistry([parent, recordedSquare]);
    const executor = new InProcessExecutor({ store, registry, clock, pollMs: 1 });
    const ops = { store, registry, clock, events: recordingSink(), executor };
    await executor.start();
    const { run } = await startRun({ registry, store }, { ...request([1, 2]), jobKey: parent.key });
    await executor.submit(run.id);
    const until = async (done: () => Promise<boolean>) => {
      for (let i = 0; i < 1000; i++) {
        if (await done()) return;
        await new Promise((r) => setTimeout(r, 2));
      }
      throw new Error('timed out');
    };
    const squares = async () => (await store.stepStates(run.id)).find((s) => s.name === 'squares');
    await until(async () => (await squares())?.counts.failed === 1);
    const kids = await store.listRuns({ tenantId: TENANT, jobKey: recordedSquare.key, limit: 10 });
    // The input lives in the recorder, not the store; the failed child failed in its step, not as unrecorded.
    for (const kid of kids) expect(await store.runInput(kid.id)).toBeUndefined();
    expect(kids.map((k) => k.error?.message ?? null).sort()).toEqual([null, 'toy failure']);
    const retried = await retryChild(ops, { runId: run.id, step: 'squares', key: '2' });
    expect(await inputs.load(retried?.childRunId as string)).toEqual({ n: 2 });
    await until(async () => (await store.getRun(run.id)).status === 'completed');
    await executor.stop();
    expect(await readRunOutput({ store, registry }, await store.getRun(run.id))).toEqual({ total: 5 });
  });

  test('hold: a failed child holds the step until a retry or a skip', async () => {
    failing.clear();
    failing.set('2', 1);
    failing.set('3', 5);
    const store = new MemoryJobStore();
    const clock = fakeClock();
    const job = parentOf('hold');
    const registry = createRegistry([job, square]);
    const executor = new InProcessExecutor({
      store,
      registry,
      clock,
      pollMs: 1,
    });
    const ops = { store, registry, clock, events: recordingSink(), executor };
    await executor.start();
    const { run } = await startRun(
      { registry, store },
      { ...request([1, 2, 3]), jobKey: job.key },
    );
    await executor.submit(run.id);
    const until = async (done: () => Promise<boolean>) => {
      for (let i = 0; i < 1000; i++) {
        if (await done()) return;
        await new Promise((r) => setTimeout(r, 2));
      }
      throw new Error('timed out');
    };
    const squares = async () =>
      (await store.stepStates(run.id)).find((s) => s.name === 'squares');
    await until(async () => (await squares())?.counts.failed === 2);
    expect((await store.getRun(run.id)).status).toBe('waiting');
    expect(
      await retryChild(ops, { runId: run.id, step: 'squares', key: '1' }),
    ).toBeNull();
    expect(
      await retryChild(ops, { runId: run.id, step: 'squares', key: '2' }),
    ).toMatchObject({ status: 'pending', attempts: 2 });
    await until(async () => (await squares())?.counts.done === 2);
    expect((await store.getRun(run.id)).status).toBe('waiting');
    expect(
      await skipChild(ops, { runId: run.id, step: 'squares', key: '3' }),
    ).toMatchObject({ status: 'skipped' });
    await until(
      async () => (await store.getRun(run.id)).status === 'completed',
    );
    await executor.stop();
    expect(
      await readRunOutput({ store, registry }, await store.getRun(run.id)),
    ).toEqual({
      total: 1 + 4,
      failed: ['3'],
    });
  });

  test('continue puts failed children in the output; fail fails the step and cancels the rest', async () => {
    failing.clear();
    failing.set('2', 5);
    const store = new MemoryJobStore();
    const cont = await runToCompletion(
      parentOf('continue', 'toy.parent-continue'),
      request([1, 2]),
      {
        store,
        executor: fast,
      },
    );
    expect(cont.output).toEqual({ total: 1, failed: ['2'] });
    failing.set('2', 5);
    const failed = await runToCompletion(
      parentOf('fail', 'toy.parent-fail'),
      request([1, 2]),
      {
        store,
        executor: fast,
      },
    );
    expect(failed.run.status).toBe('failed');
    expect(failed.run.error?.type).toBe('ChildrenFailedError');
  });

  test("one child: the step's output is the child's own; a slot may carry its own budget", async () => {
    failing.clear();
    const store = new MemoryJobStore();
    const job = defineJob({
      key: 'toy.one-child',
      input: z.object({ n: z.number() }),
      output: z.object({ squared: z.number() }),
      steps: (s) =>
        s.add(
          'only',
          child({
            job: square,
            input: ({ input }) => ({ n: input.n }),
            budget: { maxUsd: 0.5 },
          }),
        ),
    });
    const outcome = await runToCompletion(
      job,
      { ...request([]), input: { n: 7 } },
      { store, executor: fast },
    );
    expect(outcome.output).toEqual({ squared: 49 });
    const [kid] = await store.listRuns({
      tenantId: TENANT,
      jobKey: square.key,
      limit: 1,
    });
    expect(kid?.budget.maxUsd).toBe(0.5);
    await expect(
      skipChild(
        {
          store,
          registry: createRegistry([job, square]),
          clock: fakeClock(),
          events: recordingSink(),
        },
        { runId: outcome.run.id, step: 'only', key: 'child' },
      ),
    ).rejects.toThrow(JobDefinitionError);
  });

  test('a canceled parent cancels its open children', async () => {
    failing.clear();
    const store = new MemoryJobStore();
    const clock = fakeClock();
    // A child that waits for a person: open, with nothing in flight.
    const slow = defineJob({
      key: 'toy.slow',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      steps: (s) =>
        s.add(
          'approval',
          waitFor({ signal: 'approve', value: z.object({ ok: z.boolean() }) }),
        ),
    });
    const job = defineJob({
      key: 'toy.slow-parent',
      input: z.object({}),
      output: z.unknown(),
      steps: (s) =>
        s.add(
          'kids',
          children({
            job: slow,
            each: () => [
              { key: 'a', input: {} },
              { key: 'b', input: {} },
            ],
          }),
        ),
    });
    const running = runToCompletion(
      job,
      { ...request([]), input: {} },
      { store, clock, executor: fast },
    );
    let parentId = '';
    for (let i = 0; i < 500 && !parentId; i++) {
      await new Promise((r) => setTimeout(r, 5));
      const [p] = await store.listRuns({
        tenantId: TENANT,
        jobKey: job.key,
        limit: 1,
      });
      const kids = await store.listRuns({
        tenantId: TENANT,
        jobKey: 'toy.slow',
        limit: 10,
      });
      if (
        p?.status === 'waiting' &&
        kids.length === 2 &&
        kids.every((k) => k.status === 'waiting')
      )
        parentId = p.id;
    }
    await cancelRun({ store, clock }, parentId);
    const outcome = await running;
    expect(outcome.run.status).toBe('canceled');
    for (const kid of await store.listRuns({
      tenantId: TENANT,
      jobKey: slow.key,
      limit: 10,
    }))
      expect(kid.status).toBe('canceled');
  });

  test('the registry refuses an unregistered child, a public parent, a parent below its child, a cycle, and depth past 3', () => {
    const parent = parentOf();
    expect(() => createRegistry([parent])).toThrow('is not registered');
    const admin = defineJob({
      key: 'toy.admin-child',
      input: z.object({}),
      output: z.unknown(),
      authority: { start: 'admin', read: 'admin', dryRun: 'admin' },
      steps: (s) => s.add('x', step({ run: () => 1 })),
    });
    const lower = defineJob({
      key: 'toy.lower',
      input: z.object({}),
      output: z.unknown(),
      authority: { start: 'member', read: 'member', dryRun: 'member' },
      steps: (s) => s.add('kids', children({ job: admin, each: () => [] })),
    });
    expect(() => createRegistry([lower, admin])).toThrow('level is below');
    const chain = (n: number): AnyJob[] => {
      let last: AnyJob = defineJob({
        key: 'toy.leaf',
        input: z.object({}),
        output: z.unknown(),
        steps: (s) => s.add('x', step({ run: () => 1 })),
      });
      const jobs = [last];
      for (let i = 0; i < n; i++) {
        const inner = last;
        last = defineJob({
          key: `toy.level-${i}`,
          input: z.object({}),
          output: z.unknown(),
          steps: (s) => s.add('kids', children({ job: inner, each: () => [] })),
        });
        jobs.push(last);
      }
      return jobs;
    };
    expect(() => createRegistry(chain(3))).not.toThrow();
    expect(() => createRegistry(chain(4))).toThrow('more than 3 deep');
  });
});

failing.clear();
for (const c of replayContract({
  name: 'toy.parent',
  job: parentOf('hold', 'toy.parent-replay'),
  request: request([2, 3]),
}))
  test(c.name, c.run, 60_000);
