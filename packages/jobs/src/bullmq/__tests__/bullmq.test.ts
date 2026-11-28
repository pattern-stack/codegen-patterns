import { describe, expect, test } from 'bun:test';
import type { JobsOptions } from 'bullmq';
import { localLimiters } from '../../adapters/local-limiter.ts';
import { MemoryJobStore } from '../../adapters/memory-store.ts';
import { createRegistry } from '../../define/registry.ts';
import { readRunOutput } from '../../engine/context.ts';
import { startRun } from '../../engine/start-run.ts';
import { fakeClock } from '../../testing/fake-clock.ts';
import { hang, ids, scoreOf, toyScoring } from '../../testing/toy-jobs.ts';
import {
  BullmqExecutor,
  SWEEP_RUNS,
  VERSION_GRACE_MS,
} from '../bullmq-executor.ts';
import {
  chunkJobId,
  type JobEngineJob,
  type JobEngineJobData,
  type JobEngineQueue,
} from '../job-data.ts';

interface Added {
  name: string;
  data: JobEngineJobData;
  opts: JobsOptions;
}

/**
 * A queue as BullMQ keeps one, for what the executor relies on: a job id is added once while that job exists, and a
 * deduplicated job keeps at most one waiting beside one active (`keepLastIfActive`).
 */
function fakeQueue() {
  const added: Added[] = [];
  const waiting: Added[] = [];
  const active = new Set<string>();
  const key = (a: Added) =>
    a.opts.deduplication?.id ?? a.opts.jobId ?? `${added.length}`;
  const queue: JobEngineQueue = {
    async add(name, data, opts = {}) {
      const job = { name, data, opts };
      added.push(job);
      const k = key(job);
      if (waiting.some((w) => key(w) === k)) return;
      if (active.has(k) && !opts.deduplication?.keepLastIfActive) return;
      waiting.push(job);
    },
  };
  /** Runs waiting jobs through `handle`, one at a time, until none is left. */
  async function pump(executor: BullmqExecutor, limit = 200) {
    const outcomes: string[] = [];
    for (let n = 0; n < limit; n++) {
      const job = waiting.shift();
      if (!job) return outcomes;
      const k = key(job);
      active.add(k);
      try {
        outcomes.push(await executor.handle(job as JobEngineJob));
      } finally {
        active.delete(k);
      }
    }
    throw new Error('the queue did not drain');
  }
  return { queue, added, waiting, pump };
}

const request = (jobKey: string, n: number, chunkSize = 2) => ({
  jobKey,
  input: { n },
  tenantId: 'tenant-bullmq',
  trigger: 'eval' as const,
  requestedBy: null,
  budget: { maxItems: n },
  chunkSize,
});

function setup(options: Parameters<typeof toyScoring>[0] = {}) {
  const clock = fakeClock();
  const store = new MemoryJobStore({ now: clock.now, keepsValues: false });
  const toy = toyScoring({ recorded: true, ...options });
  const registry = createRegistry([toy.job]);
  const q = fakeQueue();
  const executor = new BullmqExecutor(q.queue, store, registry, {
    clock,
    limiters: localLimiters({ toy: { inFlight: 1 } }),
    owner: 'worker-a',
    warn: () => {},
  });
  return { clock, store, toy, registry, executor, ...q };
}

describe('BullmqExecutor', () => {
  test("job code runs in its run's scope: each advance and each chunk (RunScope, as the in-process executor's)", async () => {
    const clock = fakeClock();
    const store = new MemoryJobStore({ now: clock.now, keepsValues: false });
    const toy = toyScoring({ recorded: true });
    const registry = createRegistry([toy.job]);
    const q = fakeQueue();
    const entered: string[] = [];
    const executor = new BullmqExecutor(q.queue, store, registry, {
      clock,
      limiters: localLimiters({ toy: { inFlight: 1 } }),
      owner: 'worker-a',
      warn: () => {},
      around: async (target, fn) => {
        entered.push(`${target.tenantId}/${target.jobKey}/${target.runId}`);
        return fn();
      },
    });
    await executor.start();
    const { run } = await startRun({ registry, store }, request(toy.job.key, 5));
    await executor.submit(run.id);
    const outcomes = await q.pump(executor);
    expect((await store.getRun(run.id)).status).toBe('completed');
    // One scope entry per advance and per chunk job the queue ran, each for this run.
    expect(entered).toHaveLength(outcomes.filter((o) => o !== 'skipped').length);
    expect(new Set(entered)).toEqual(new Set([`tenant-bullmq/${toy.job.key}/${run.id}`]));
  });

  test('a submit queues one deduplicated advance, run once and kept nowhere', async () => {
    const { store, registry, toy, executor, added } = setup();
    const { run } = await startRun(
      { registry, store },
      request(toy.job.key, 4),
    );
    await executor.submit(run.id);
    await executor.submit(run.id);
    expect(added[0]).toEqual({
      name: 'advance',
      data: { runId: run.id, workflowContext: undefined },
      opts: {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
        deduplication: { id: `advance-${run.id}`, keepLastIfActive: true },
      },
    });
    expect(added).toHaveLength(2);
  });

  test('a run completes through advances and chunk jobs; every job runs once, chunks by their attempt id', async () => {
    const { store, registry, toy, executor, added, pump } = setup();
    await executor.start();
    const { run } = await startRun(
      { registry, store },
      request(toy.job.key, 5),
    );
    await executor.submit(run.id);
    await pump(executor);
    expect((await store.getRun(run.id)).status).toBe('completed');
    expect(
      await readRunOutput({ store, registry }, await store.getRun(run.id)),
    ).toEqual({
      count: 5,
      failed: 0,
      total: Math.round(ids(5).reduce((a, r) => a + scoreOf(r), 0) * 100),
    });
    for (const a of added) {
      expect(a.opts.attempts).toBe(1);
      expect(a.opts.removeOnComplete).toBe(true);
      expect(a.opts.removeOnFail).toBe(true);
    }
    const chunks = added.filter((a) => a.name === 'chunk');
    // A chunk is dispatched again while its job still waits (planning, each advance): the id makes that a no-op.
    expect([...new Set(chunks.map((c) => c.opts.jobId))]).toEqual(
      [0, 1, 2].map((index) =>
        chunkJobId({ runId: run.id, step: 'score', index, attempts: 0 }),
      ),
    );
    expect(chunks.every((c) => c.opts.delay === 0)).toBe(true);
  });

  test('the chunk job id is stable, a hash of the chunk and its attempt, and holds no colon', () => {
    const c = { runId: 'r', step: 's', index: 3, attempts: 1 };
    expect(chunkJobId(c)).toBe(chunkJobId({ ...c }));
    expect(chunkJobId(c)).not.toBe(chunkJobId({ ...c, attempts: 2 }));
    expect(chunkJobId(c)).toMatch(/^chunk-[0-9a-f]{40}$/);
  });

  test('a chunk job whose chunk is held, settled or unknown is skipped', async () => {
    const { store, registry, toy, executor, pump, waiting } = setup();
    await executor.start();
    const { run } = await startRun(
      { registry, store },
      request(toy.job.key, 2),
    );
    await executor.submit(run.id);
    // The advance plans and dispatches; another worker takes the chunk first.
    const [advance] = waiting.splice(0, 1);
    if (!advance) throw new Error('no advance queued');
    await executor.handle(advance as JobEngineJob);
    expect(await store.claimChunk('worker-b', 60_000)).not.toBeNull();
    const outcomes = await pump(executor);
    expect(outcomes[0]).toBe('skipped');
  });

  test('a transient failure settles a retry: its run is resubmitted and the chunk dispatched again after its backoff', async () => {
    const { clock, store, registry, toy, executor, added, pump } = setup({
      transientCalls: 1,
      retry: {
        initialIntervalMs: 5_000,
        backoffCoefficient: 2,
        maximumAttempts: 3,
      },
    });
    await executor.start();
    const { run } = await startRun(
      { registry, store },
      request(toy.job.key, 2),
    );
    await executor.submit(run.id);
    const outcomes = await pump(executor);
    expect(outcomes).toContain('retry');
    const retried = added.find(
      (a) =>
        a.opts.jobId ===
        chunkJobId({ runId: run.id, step: 'score', index: 0, attempts: 1 }),
    );
    expect(retried?.opts.delay).toBe(5_000);
    // The fake queue ignores delays: the dispatched retry ran before its time and was skipped, so move the clock on
    // and let the sweep's resubmit dispatch it again.
    clock.advance(5_000);
    await executor.sweep();
    await pump(executor);
    expect((await store.getRun(run.id)).status).toBe('completed');
  });

  test('a stop without drain aborts its in-flight chunk and gives back only its own claim, without spending an attempt', async () => {
    let reached: () => void = () => {};
    const atCall = new Promise<void>((r) => {
      reached = r;
    });
    const { store, registry, toy, executor, waiting } = setup({
      onCall: (_n, _call, signal) => {
        reached();
        return hang(signal);
      },
    });
    await executor.start();
    const { run } = await startRun(
      { registry, store },
      request(toy.job.key, 4),
    );
    await executor.submit(run.id);
    const advance = waiting.shift();
    if (!advance) throw new Error('no advance queued');
    await executor.handle(advance as JobEngineJob);
    const theirs = await store.claimChunk('worker-b', 60_000, {
      runId: run.id,
      step: 'score',
      index: 1,
    });
    expect(theirs).not.toBeNull();
    const chunk = waiting.find((w) => w.name === 'chunk');
    if (!chunk) throw new Error('no chunk queued');
    const handled = executor.handle(chunk as JobEngineJob);
    await atCall;
    await executor.stop({ drain: false });
    expect(await handled).toBe('aborted');
    const chunks = await store.chunks(run.id);
    expect(chunks.map((c) => [c.index, c.status, c.attempts])).toEqual([
      [0, 'pending', 0],
      [1, 'running', 1],
    ]);
    expect(await executor.handle(chunk as JobEngineJob)).toBe('skipped');
  });

  test('a run made by another version of its job is skipped and left pending', async () => {
    const { store, toy, executor, pump, queue } = setup();
    await executor.start();
    const { run } = await store.createRun({
      ...request(toy.job.key, 2),
      input: undefined,
      jobVersion: 'an-older-version',
    });
    await queue.add('advance', { runId: run.id });
    expect(await pump(executor)).toEqual(['skipped']);
    expect((await store.getRun(run.id)).status).toBe('pending');
  });

  test('past the drain window, a run of a version no longer deployed fails on its advance (JobVersionGoneError)', async () => {
    const { store, toy, executor, pump, queue, clock } = setup();
    await executor.start();
    const { run } = await store.createRun({
      ...request(toy.job.key, 2),
      input: undefined,
      jobVersion: 'an-older-version',
    });
    // Its chunk is never worked under another version, drain window or not.
    clock.advance(VERSION_GRACE_MS);
    await queue.add('chunk', { runId: run.id, step: 'score', index: 0 });
    expect(await pump(executor)).toEqual(['skipped']);
    await queue.add('advance', { runId: run.id });
    expect(await pump(executor)).toEqual(['advanced']);
    const failed = await store.getRun(run.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.type).toBe('JobVersionGoneError');
  });

  test('a new executor accepts jobs before start(): a booting worker processes what it fetches', async () => {
    const { store, registry, toy, executor, pump } = setup();
    const { run } = await startRun(
      { registry, store },
      request(toy.job.key, 3),
    );
    await executor.submit(run.id);
    const outcomes = await pump(executor);
    expect(outcomes).not.toContain('skipped');
    expect((await store.getRun(run.id)).status).toBe('completed');
  });

  test('a run of a job this process does not know is skipped with a warning, not failed', async () => {
    const clock = fakeClock();
    const store = new MemoryJobStore({ now: clock.now, keepsValues: false });
    const toy = toyScoring({ recorded: true });
    const q = fakeQueue();
    const warnings: string[] = [];
    const executor = new BullmqExecutor(q.queue, store, createRegistry([]), {
      clock,
      warn: (m) => warnings.push(m),
    });
    const { run } = await store.createRun({
      ...request(toy.job.key, 2),
      input: undefined,
      jobVersion: toy.job.version,
    });
    await q.queue.add('advance', { runId: run.id });
    expect(await q.pump(executor)).toEqual(['skipped']);
    expect(warnings).toHaveLength(1);
    expect((await store.getRun(run.id)).status).toBe('pending');
  });

  describe("the trace carry: every context on an engine job is its own run's root", () => {
    const ctxA = { root: 'opened-for-the-job' };
    const ctxB = { root: 'the-run' };

    test("a submit adds its advance with no context, even inside a caller's", async () => {
      const { store, registry, toy, executor, added } = setup();
      const { run } = await startRun(
        { registry, store },
        request(toy.job.key, 2),
      );
      await executor.submit(run.id);
      expect(added).toHaveLength(1);
      expect(added[0]?.data.workflowContext).toBeUndefined();
    });

    test('a handled job carrying a context stamps it on every chunk and advance it adds, over the trace passed', async () => {
      const { store, registry, toy, executor, added, waiting } = setup();
      const { run } = await startRun(
        { registry, store },
        request(toy.job.key, 4),
      );
      await executor.submit(run.id);
      waiting.splice(0);
      const before = added.length;
      await executor.handle(
        { name: 'advance', data: { runId: run.id, workflowContext: ctxB } },
        { trace: ctxA },
      );
      const chunk = waiting.find((w) => w.name === 'chunk');
      if (!chunk) throw new Error('no chunk queued');
      await executor.handle(chunk as JobEngineJob, { trace: ctxA });
      const after = added.slice(before);
      expect(after.some((a) => a.name === 'chunk')).toBe(true);
      expect(after.some((a) => a.name === 'advance')).toBe(true);
      expect(after.every((a) => a.data.workflowContext === ctxB)).toBe(true);
    });

    test('a handled job that arrived with no context stamps the trace passed to handle', async () => {
      const { store, registry, toy, executor, added, waiting } = setup();
      const { run } = await startRun(
        { registry, store },
        request(toy.job.key, 4),
      );
      await executor.submit(run.id);
      const [advance] = waiting.splice(0, 1);
      if (!advance) throw new Error('no advance queued');
      await executor.handle(advance as JobEngineJob, { trace: ctxA });
      const chunks = added.filter((a) => a.name === 'chunk');
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((a) => a.data.workflowContext === ctxA)).toBe(true);
    });

    test('successive sweeps rotate through more open runs than one sweep resubmits', async () => {
      const { store, registry, toy, executor, added, clock } = setup();
      const runs: string[] = [];
      for (let n = 0; n <= SWEEP_RUNS; n++) {
        runs.push(
          (await startRun({ registry, store }, request(toy.job.key, 2))).run.id,
        );
        clock.advance(1);
      }
      const resubmitted = () => added.map((a) => a.data.runId);
      expect((await executor.sweep()).resubmitted).toBe(SWEEP_RUNS);
      expect(resubmitted()).toEqual(runs.slice(0, SWEEP_RUNS));
      added.length = 0;
      // The newest run, past the first page, is reached by the next sweep; the one after starts over.
      expect((await executor.sweep()).resubmitted).toBe(1);
      expect(resubmitted()).toEqual(runs.slice(SWEEP_RUNS));
      added.length = 0;
      expect((await executor.sweep()).resubmitted).toBe(SWEEP_RUNS);
      expect(resubmitted()[0]).toBe(runs[0]);
    });

    test('a sweep resubmits with no context', async () => {
      const { store, registry, toy, executor, added } = setup();
      await startRun({ registry, store }, request(toy.job.key, 2));
      expect((await executor.sweep()).resubmitted).toBe(1);
      expect(added).toHaveLength(1);
      expect(added[0]?.name).toBe('advance');
      expect(added[0]?.data.workflowContext).toBeUndefined();
    });
  });
});
