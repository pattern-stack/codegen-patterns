import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  InProcessExecutor,
  runToCompletion,
} from '../adapters/in-process-executor.ts';
import { localLimiter, localLimiters } from '../adapters/local-limiter.ts';
import { logSink } from '../adapters/log-sink.ts';
import { memoryRecorder } from '../adapters/memory-recorder.ts';
import { MemoryJobStore } from '../adapters/memory-store.ts';
import { defineJob } from '../define/define-job.ts';
import { mapStep } from '../define/map-step.ts';
import { createRegistry } from '../define/registry.ts';
import { step, waitFor } from '../define/step.ts';
import { createEmitter } from '../engine/emitter.ts';
import { startRun } from '../engine/start-run.ts';
import { ThrottledError } from '../model/errors.ts';
import { fakeClock } from '../testing/fake-clock.ts';
import { limiterContract } from '../testing/limiter-contract.ts';
import { recordingSink } from '../testing/recording-sink.ts';
import { storeContract } from '../testing/store-contract.ts';
import { hang, ids, toyScoring, toyStopping } from '../testing/toy-jobs.ts';

for (const keepsValues of [true, false])
  describe(`MemoryJobStore (keepsValues: ${keepsValues})`, () => {
    for (const c of storeContract(() => {
      const clock = fakeClock();
      return {
        store: new MemoryJobStore({ now: clock.now, keepsValues }),
        clock,
        tenants: ['tenant-contract-a', 'tenant-contract-b'],
        user: 'user-contract',
      };
    }))
      test(c.name, c.run);
  });

describe('InProcessExecutor', () => {
  test('a stop without drain aborts its chunks and gives back only its own claims, without spending an attempt', async () => {
    const store = new MemoryJobStore();
    let reached: () => void = () => {};
    const atFirst = new Promise<void>((r) => {
      reached = r;
    });
    const toy = toyScoring({
      onCall: (_n, _call, signal) => {
        reached();
        return hang(signal);
      },
    });
    const registry = createRegistry([toy.job]);
    const { run } = await startRun(
      { registry, store },
      {
        jobKey: toy.job.key,
        input: { n: 4 },
        tenantId: 'tenant-executor',
        trigger: 'eval',
        requestedBy: null,
        budget: { maxItems: 4 },
        chunkSize: 2,
      },
    );
    // Another worker holds the second chunk.
    const executor = new InProcessExecutor({
      store,
      registry,
      chunkConcurrency: 1,
      pollMs: 1,
    });
    await executor.start();
    await executor.submit(run.id);
    await atFirst;
    const [theirs] = await store.claimChunks('another-worker', 1, 60_000);
    expect(theirs?.index).toBe(1);
    await executor.stop({ drain: false });
    const { steps } = await store.progress(run.id);
    expect(steps[1]?.chunks).toMatchObject({ pending: 1, running: 1 });
    const [again] = await store.claimChunks('w', 1, 60_000);
    expect(again).toMatchObject({ index: 0, attempts: 1 });
  });

  test('a store that can lose writes refuses a job with side effects before any run is made', async () => {
    const toy = toyScoring();
    const job = {
      ...toy.job,
      steps: toy.job.steps.map((s) =>
        s.erased.kind === 'step'
          ? { ...s, erased: { ...s.erased, effect: 'side-effect' as const } }
          : s,
      ),
    };
    const store = new MemoryJobStore();
    const registry = createRegistry([job]);
    await expect(
      startRun(
        { registry, store },
        {
          jobKey: job.key,
          input: { n: 1 },
          tenantId: 'tenant-executor',
          trigger: 'eval',
          requestedBy: null,
          budget: { maxItems: 1 },
          dedupeKey: 'publish',
        },
      ),
    ).rejects.toThrow('side effects');
    expect(
      await store.listRuns({ tenantId: 'tenant-executor', limit: 10 }),
    ).toEqual([]);
  });

  test('a claim swept while its worker lives is fenced out: the same owner re-claims it, and each item is asked once', async () => {
    let failing = false;
    class FlakyRenewStore extends MemoryJobStore {
      override async renewClaim(
        ...args: Parameters<MemoryJobStore['renewClaim']>
      ) {
        if (failing) throw new Error('the store is unreachable');
        return super.renewClaim(...args);
      }
    }
    const store = new FlakyRenewStore();
    const toy = toyScoring({
      batchMax: 1,
      onCall: () => new Promise((r) => setTimeout(r, 20)),
    });
    setTimeout(() => {
      failing = true;
    }, 30);
    setTimeout(() => {
      failing = false;
    }, 120);
    const { run: done, output } = await runToCompletion(
      toy.job,
      {
        input: { n: 10 },
        tenantId: 'tenant-executor',
        trigger: 'eval',
        requestedBy: null,
        budget: { maxItems: 10 },
      },
      {
        store,
        limiters: localLimiters({ toy: { inFlight: 1 } }),
        executor: { pollMs: 1, chunkConcurrency: 2, claimTtlMs: 60 },
      },
    );
    expect(done.status).toBe('completed');
    expect(output?.count).toBe(10);
    const asked = toy.calls.flatMap((c) => c.refs);
    expect(asked.sort()).toEqual(ids(10));
  });
});

describe('InProcessExecutor, idle', () => {
  test("waiting out one run's backoff never holds up work another process puts in the store", async () => {
    const store = new MemoryJobStore();
    const toy = toyScoring({
      transientCalls: 1,
      retry: {
        initialIntervalMs: 60_000,
        backoffCoefficient: 1,
        maximumAttempts: 3,
      },
    });
    const registry = createRegistry([toy.job]);
    const ask = (n: number) => ({
      jobKey: toy.job.key,
      input: { n },
      tenantId: 'tenant-idle',
      trigger: 'eval' as const,
      requestedBy: null,
      budget: { maxItems: n },
    });
    const { run: backingOff } = await startRun({ registry, store }, ask(2));
    const executor = new InProcessExecutor({
      store,
      registry,
      pollMs: 20,
      chunkConcurrency: 1,
    });
    await executor.start();
    await executor.submit(backingOff.id);
    const until = async (check: () => Promise<boolean>, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await check()) return true;
        await new Promise((r) => setTimeout(r, 5));
      }
      return false;
    };
    // The first call fails: its chunk waits out a minute's backoff, and the executor is idle.
    expect(
      await until(
        async () =>
          (await store.chunks(backingOff.id)).some(
            (c) => c.status === 'pending' && c.attempts === 1,
          ),
        1_000,
      ),
    ).toBe(true);
    // Another process puts a run's chunk in the shared store, without telling this executor.
    const { run: other } = await startRun({ registry, store }, ask(2));
    await store.transition(other.id, { to: 'running', from: 'pending' });
    await store.startStep(
      other.id,
      { name: 'list', index: 0, kind: 'step' },
      { attempts: 0 },
    );
    await store.recordStep(other.id, 'list', {
      status: 'completed',
      output: ids(2),
    });
    await store.startStep(
      other.id,
      { name: 'score', index: 1, kind: 'map' },
      { attempts: 0 },
    );
    await store.planItems(other.id, 'score', {
      refs: ids(2),
      keys: ids(2).map((r) => `m1:${r}`),
      next: null,
    });
    expect(
      await until(
        async () =>
          (await store.chunks(other.id)).every((c) => c.status === 'completed'),
        500,
      ),
    ).toBe(true);
    await executor.stop();
  });
});

/** Calls `afterPark` once, as the next park of a run resolves inside its advance. */
class ParkHookStore extends MemoryJobStore {
  afterPark: (() => void) | null = null;

  override async park(
    ...args: Parameters<MemoryJobStore['park']>
  ): ReturnType<MemoryJobStore['park']> {
    const parked = await super.park(...args);
    const hook = this.afterPark;
    this.afterPark = null;
    hook?.();
    return parked;
  }
}

const kickedJob = defineJob({
  key: 'toy.kicked',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  authority: { start: 'admin', dryRun: 'tenant-wide' },
  steps: (s) =>
    s
      .add(
        'approval',
        waitFor({ signal: 'go', value: z.object({ ok: z.boolean() }) }),
      )
      .add('finish', step({ run: ({ approval }) => approval })),
});

describe('InProcessExecutor, a late kick', () => {
  // A kick that lands after the advance loop last read `again`, and before the advance is let go, still advances
  // the run. The kick is moved a microtask at a time across the advance's end; nothing else (no poll, no sweep)
  // advances the run, as the executor is never started.
  test('a kick at any point of an ending advance still advances the run', async () => {
    const registry = createRegistry([kickedJob]);
    for (let delay = 0; delay < 40; delay++) {
      const store = new ParkHookStore();
      const executor = new InProcessExecutor({
        store,
        registry,
        pollMs: 60_000,
      });
      const { run } = await startRun(
        { registry, store },
        {
          jobKey: kickedJob.key,
          input: {},
          tenantId: 'tenant-kick',
          trigger: 'eval',
          requestedBy: null,
          budget: { maxItems: 0 },
        },
      );
      const kicked = new Promise<void>((resolve, reject) => {
        store.afterPark = () => {
          (async () => {
            await store.settleWait(run.id, 'approval', {
              signal: 'go',
              output: { ok: true },
              by: 'user-kick',
            });
            for (let i = 0; i < delay; i++) await Promise.resolve();
            await executor.submit(run.id);
          })().then(resolve, reject);
        };
      });
      await executor.submit(run.id);
      await kicked;
      await executor.stop();
      expect({ delay, status: (await store.getRun(run.id)).status }).toEqual({
        delay,
        status: 'completed',
      });
    }
  });
});

describe('InProcessExecutor, shared store', () => {
  test("claims only its own jobs' chunks: another job's run in the store is never taken or failed", async () => {
    const store = new MemoryJobStore();
    const mine = toyScoring();
    const theirs = toyStopping();
    const ask = (jobKey: string, n: number) => ({
      jobKey,
      input: { n },
      tenantId: 'tenant-shared',
      trigger: 'eval' as const,
      requestedBy: null,
      budget: { maxItems: n },
    });
    // Another process's run of another job, its chunks planned and waiting.
    const { run: other } = await startRun(
      { registry: createRegistry([theirs.job]), store },
      ask(theirs.job.key, 4),
    );
    await store.transition(other.id, { to: 'running', from: 'pending' });
    await store.startStep(
      other.id,
      { name: 'list', index: 0, kind: 'step' },
      { attempts: 0 },
    );
    await store.recordStep(other.id, 'list', {
      status: 'completed',
      output: ids(4),
    });
    await store.startStep(
      other.id,
      { name: 'score', index: 1, kind: 'map' },
      { attempts: 0 },
    );
    await store.planItems(other.id, 'score', {
      refs: ids(4),
      keys: ids(4).map((r) => `m1:${r}`),
      next: null,
    });
    const { run } = await runToCompletion(
      mine.job,
      {
        input: { n: 4 },
        tenantId: 'tenant-shared',
        trigger: 'eval',
        requestedBy: null,
        budget: { maxItems: 4 },
      },
      { store, executor: { pollMs: 1 } },
    );
    expect(run.status).toBe('completed');
    expect(
      (await store.chunks(other.id)).map((c) => [c.status, c.attempts]),
    ).toEqual((await store.chunks(other.id)).map(() => ['pending', 0]));
    expect(theirs.calls).toHaveLength(0);
  });
});

describe('the emitter', () => {
  test('a failing sink never stops the others, and step.progress is throttled per step', async () => {
    const clock = fakeClock();
    const seen = recordingSink();
    const errors: string[] = [];
    const emitter = createEmitter(
      [
        {
          emit() {
            throw new Error('down');
          },
        },
        seen,
      ],
      clock,
      {
        progressIntervalMs: 1_000,
        onSinkError: (_e, ev) => errors.push(ev.type),
      },
    );
    const base = {
      runId: 'r',
      jobKey: 'k',
      jobVersion: 'v',
      tenantId: 'o',
      at: clock.now(),
      step: 's',
      attempt: 1,
    };
    const progress = {
      ...base,
      type: 'step.progress' as const,
      counts: { total: 1, done: 0, cached: 0, failed: 0, skipped: 0 },
    };
    await emitter.emit(progress);
    await emitter.emit(progress);
    clock.advance(1_000);
    await emitter.emit(progress);
    await emitter.emit({ ...progress, step: 'other' });
    await emitter.emit({
      ...base,
      type: 'step.completed',
      counts: progress.counts,
      speculation: null,
    });
    await emitter.emit(progress);
    expect(seen.types()).toEqual([
      'step.progress',
      'step.progress',
      'step.progress',
      'step.completed',
      'step.progress',
    ]);
    expect(errors).toHaveLength(5);
  });
});

describe('localLimiters: the limiter contract', () => {
  for (const c of limiterContract({
    make: (config, clock) => {
      const limiters = localLimiters(config, { clock });
      return [limiters, limiters];
    },
  }))
    test(c.name, c.run);
});

describe('localLimiter', () => {
  const settledWithin = async (p: Promise<unknown>, ms: number) =>
    Promise.race([
      p.then(() => true),
      new Promise((r) => setTimeout(() => r(false), ms)),
    ]);

  test('at most inFlight permits are out; a release lets the next waiter in', async () => {
    const limiter = localLimiter({ inFlight: 2 });
    const a = await limiter.acquire({ tokens: 1 });
    await limiter.acquire({ tokens: 1 });
    const third = limiter.acquire({ tokens: 1 });
    expect(await settledWithin(third, 20)).toBe(false);
    a.release();
    expect(await settledWithin(third, 20)).toBe(true);
  });

  test('a 429 halves the calls in flight and waits out Retry-After for every caller; 20 OK calls win a slot back', async () => {
    const limiter = localLimiter({ inFlight: 4 });
    const p = await limiter.acquire({ tokens: 1 });
    p.release({ throttled: true, retryAfterMs: 40 });
    expect(limiter.cap).toBe(2);
    const blocked = limiter.acquire({ tokens: 1 });
    expect(await settledWithin(blocked, 15)).toBe(false);
    expect(await settledWithin(blocked, 80)).toBe(true);
    (await blocked).release();
    for (let i = 0; i < 20; i++)
      (await limiter.acquire({ tokens: 1 })).release();
    expect(limiter.cap).toBe(3);
  });

  test('calls and tokens per minute hold a sliding window', async () => {
    let now = 0;
    const calls = localLimiter({ inFlight: 10, callsPerMinute: 2 }, () => now);
    (await calls.acquire({ tokens: 1 })).release();
    (await calls.acquire({ tokens: 1 })).release();
    now = 1_000;
    const third = calls.acquire({ tokens: 1 }, AbortSignal.timeout(20));
    expect(await settledWithin(third, 10)).toBe(false);
    await third.catch(() => {});
    now = 60_001;
    expect(await settledWithin(calls.acquire({ tokens: 1 }), 10)).toBe(true);

    now = 0;
    const tokens = localLimiter(
      { inFlight: 10, tokensPerMinute: 1000 },
      () => now,
    );
    (await tokens.acquire({ tokens: 900 })).release({ tokens: 400 });
    // Corrected on release: 400 used, so 500 more fit.
    expect(await settledWithin(tokens.acquire({ tokens: 500 }), 10)).toBe(true);
  });

  test('an aborted wait leaves the queue', async () => {
    const limiter = localLimiter({ inFlight: 1 });
    const held = await limiter.acquire({ tokens: 1 });
    const c = new AbortController();
    const waiting = limiter.acquire({ tokens: 1 }, c.signal);
    c.abort(new Error('gone'));
    await expect(waiting).rejects.toThrow('gone');
    held.release();
    expect(limiter.inFlight).toBe(0);
  });

  test('a ThrottledError from a batch throttles the step’s limiter', async () => {
    let calls = 0;
    const job = defineJob({
      key: 'toy.throttled',
      input: z.object({}),
      output: z.object({
        results: z.array(z.unknown()),
        failed: z.array(z.unknown()),
      }),
      steps: (s) =>
        s.add(
          'ask',
          mapStep({
            items: () => ['a'],
            key: (r) => r,
            run: async (batch) => {
              calls++;
              if (calls === 1)
                throw new ThrottledError('429', { retryAfterMs: 1 });
              return batch.map(() => 1);
            },
            batch: { max: 1 },
            limiter: 'throttled',
            retry: {
              initialIntervalMs: 1,
              backoffCoefficient: 1,
              maximumAttempts: 3,
            },
          }),
        ),
    });
    const limiter = localLimiter({ inFlight: 4 });
    const outcome = await runToCompletion(
      job,
      {
        input: {},
        tenantId: 'tenant-limiter',
        trigger: 'eval',
        requestedBy: null,
        budget: { maxItems: 1 },
      },
      {
        store: new MemoryJobStore(),
        limiters: { get: () => limiter },
        executor: { pollMs: 1 },
      },
    );
    expect(outcome.run.status).toBe('completed');
    expect(calls).toBe(2);
    expect(limiter.cap).toBe(2);
  });
});

describe('a throttle is never a failed attempt', () => {
  const THROTTLES = 5;
  const once = {
    initialIntervalMs: 1,
    backoffCoefficient: 1,
    maximumAttempts: 1,
  };
  const request = {
    input: {},
    tenantId: 'tenant-throttle',
    trigger: 'eval' as const,
    requestedBy: null,
    budget: { maxItems: 2 },
  };

  test(`${THROTTLES} throttles in a row on one attempt: the map step's items still complete`, async () => {
    // Our own ThrottledError, and a provider's error carrying status 429.
    for (const own of [true, false]) {
      let calls = 0;
      const job = defineJob({
        key: `toy.throttled-${own ? 'own' : 'provider'}`,
        input: z.object({}),
        output: z.unknown(),
        steps: (s) =>
          s.add(
            'ask',
            mapStep({
              items: () => ['a', 'b'],
              key: (r) => r,
              run: async (batch) => {
                if (++calls <= THROTTLES)
                  throw own
                    ? new ThrottledError('429', { retryAfterMs: 1 })
                    : Object.assign(new Error('slow down'), {
                        status: 429,
                        retryAfterMs: 1,
                      });
                return batch.map(() => 1);
              },
              batch: { max: 2 },
              limiter: 'throttled',
              retry: once,
            }),
          ),
      });
      const store = new MemoryJobStore();
      const outcome = await runToCompletion(job, request, {
        store,
        limiters: localLimiters({ throttled: { inFlight: 4 } }),
        executor: { pollMs: 1 },
      });
      expect(outcome.run.status).toBe('completed');
      expect(calls).toBe(THROTTLES + 1);
      const [ask] = await store.stepStates(outcome.run.id);
      expect(ask?.counts).toMatchObject({ done: 2, failed: 0 });
    }
  });

  test(`${THROTTLES} throttles in a row on one attempt: the plain step still completes`, async () => {
    let calls = 0;
    const job = defineJob({
      key: 'toy.throttled-plain',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      steps: (s) =>
        s.add(
          'ask',
          step({
            limiter: 'throttled',
            retry: once,
            run: () => {
              if (++calls <= THROTTLES)
                throw new ThrottledError('429', { retryAfterMs: 1 });
              return { ok: true };
            },
          }),
        ),
    });
    const store = new MemoryJobStore();
    const outcome = await runToCompletion(job, request, {
      store,
      limiters: localLimiters({ throttled: { inFlight: 1 } }),
      executor: { pollMs: 1 },
    });
    expect(outcome.output).toEqual({ ok: true });
    expect(calls).toBe(THROTTLES + 1);
    const [ask] = await store.stepStates(outcome.run.id);
    expect(ask?.attempts).toBe(1);
  });
});

describe('sinks and recorders', () => {
  test('the log sink writes one JSON line per event: its type and ids', () => {
    const lines: string[] = [];
    const sink = logSink((l) => lines.push(l));
    void sink.emit({
      type: 'run.started',
      runId: 'r1',
      jobKey: 'toy',
      jobVersion: 'v',
      tenantId: 'o',
      at: new Date('2026-01-01T00:00:00Z'),
    });
    expect(JSON.parse(lines[0] as string)).toEqual({
      msg: 'job run.started',
      type: 'run.started',
      runId: 'r1',
      jobKey: 'toy',
      jobVersion: 'v',
      tenantId: 'o',
      at: '2026-01-01T00:00:00.000Z',
    });
  });

  test('the memory recorder keeps one copy per run', async () => {
    const recorder = memoryRecorder<{ ids: string[] }>();
    const output = { ids: ['a'] };
    await recorder.save('r1', output);
    output.ids.push('b');
    expect(await recorder.load('r1')).toEqual({ ids: ['a'] });
    expect(await recorder.load('r2')).toBeUndefined();
  });
});
