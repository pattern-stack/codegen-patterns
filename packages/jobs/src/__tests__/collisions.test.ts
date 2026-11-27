import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { InProcessExecutor } from '../adapters/in-process-executor.ts';
import { localLimiters } from '../adapters/local-limiter.ts';
import { MemoryJobStore } from '../adapters/memory-store.ts';
import { systemClock } from '../adapters/system-clock.ts';
import { defineJob } from '../define/define-job.ts';
import { createRegistry } from '../define/registry.ts';
import { step } from '../define/step.ts';
import { startRun } from '../engine/start-run.ts';
import { JobDefinitionError } from '../model/errors.ts';
import { SYSTEM_TENANT } from '../model/tenant.ts';
import { recordingSink } from '../testing/recording-sink.ts';

// JOBS-3 / codegen-targets d36, as Doug settled it: collision modes, the dedupe window, and priority as a pool.

const request = (over: Record<string, unknown> = {}) => ({
  jobKey: 'collide.toy',
  input: {},
  tenantId: SYSTEM_TENANT,
  trigger: 'eval' as const,
  requestedBy: null,
  budget: { maxItems: 10 },
  dedupeKey: 'one',
  ...over,
});

const until = async (check: () => Promise<boolean>, what: string) => {
  const end = Date.now() + 5_000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out: ${what}`);
};

describe("collision 'replace'", () => {
  const job = defineJob({
    key: 'collide.toy',
    input: z.object({}),
    output: z.object({}),
    steps: (s) => s.add('noop', step({ run: async () => ({}) })),
  });
  const registry = createRegistry([job]);

  test('cancels the open run on the key, then starts afresh, and says so with run.canceled', async () => {
    const store = new MemoryJobStore();
    const events = recordingSink();
    const first = await startRun({ registry, store }, request());
    const second = await startRun(
      { registry, store, events, clock: systemClock },
      request({ collision: 'replace' }),
    );
    expect(second.created).toBe(true);
    expect(second.run.id).not.toBe(first.run.id);
    expect((await store.getRun(first.run.id)).status).toBe('canceled');
    expect(events.events.map((e) => e.type)).toEqual(['run.canceled']);
  });

  test("'join' (the default) returns the open run, and a job's own collision is the default for its starts", async () => {
    const store = new MemoryJobStore();
    const first = await startRun({ registry, store }, request());
    expect((await startRun({ registry, store }, request())).run.id).toBe(first.run.id);
    const replacing = defineJob({
      key: 'collide.replacing',
      input: z.object({}),
      output: z.object({}),
      collision: 'replace',
      steps: (s) => s.add('noop', step({ run: async () => ({}) })),
    });
    const both = createRegistry([job, replacing]);
    const a = await startRun({ registry: both, store }, request({ jobKey: replacing.key }));
    const b = await startRun({ registry: both, store }, request({ jobKey: replacing.key }));
    expect(b.run.id).not.toBe(a.run.id);
    expect((await store.getRun(a.run.id)).status).toBe('canceled');
  });

  test('a dedupe window is a whole number of milliseconds', () => {
    expect(() =>
      defineJob({
        key: 'collide.bad',
        input: z.object({}),
        output: z.object({}),
        dedupeWindowMs: -1,
        steps: (s) => s.add('noop', step({ run: async () => ({}) })),
      }),
    ).toThrow(JobDefinitionError);
  });
});

describe("collision 'queue', end to end", () => {
  test('the queued run starts only when the one ahead of it finishes, one at a time per key', async () => {
    const store = new MemoryJobStore();
    const order: string[] = [];
    let release: () => void = () => {};
    const job = defineJob({
      key: 'collide.toy',
      input: z.object({ n: z.number() }),
      output: z.object({}),
      collision: 'queue',
      steps: (s) =>
        s.add(
          'work',
          step({
            run: async ({ input }) => {
              order.push(`start ${input.n}`);
              if (input.n === 1) await new Promise<void>((r) => (release = r));
              order.push(`end ${input.n}`);
              return {};
            },
          }),
        ),
    });
    const registry = createRegistry([job]);
    const executor = new InProcessExecutor({ store, registry, pollMs: 5, openSweepEvery: 1 });
    await executor.start();
    try {
      const one = await startRun({ registry, store }, request({ input: { n: 1 } }));
      await executor.submit(one.run.id);
      await until(async () => order.includes('start 1'), 'run 1 to start');
      const two = await startRun({ registry, store }, request({ input: { n: 2 } }));
      expect(two.run.status).toBe('queued');
      await executor.submit(two.run.id);
      await new Promise((r) => setTimeout(r, 50));
      expect(order).toEqual(['start 1']);
      release();
      await until(async () => (await store.getRun(two.run.id)).status === 'completed', 'run 2 to finish');
      expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
    } finally {
      await executor.stop();
    }
  });
});

describe('priority is a pool', () => {
  test('two limiters with their own capacity: a saturated one never holds the other back', async () => {
    const store = new MemoryJobStore();
    const ran: string[] = [];
    let releaseBulk: () => void = () => {};
    const jobIn = (pool: string) =>
      defineJob({
        key: `pool.${pool}`,
        input: z.object({ n: z.number() }),
        output: z.object({}),
        steps: (s) =>
          s.add(
            'work',
            step({
              limiter: pool,
              run: async ({ input }) => {
                ran.push(`${pool} ${input.n}`);
                if (pool === 'bulk') await new Promise<void>((r) => (releaseBulk = r));
                return {};
              },
            }),
          ),
      });
    const bulk = jobIn('bulk');
    const urgent = jobIn('urgent');
    const registry = createRegistry([bulk, urgent]);
    const executor = new InProcessExecutor({
      store,
      registry,
      pollMs: 5,
      limiters: localLimiters({ bulk: { inFlight: 1 }, urgent: { inFlight: 1 } }),
    });
    await executor.start();
    const start = async (job: typeof bulk, n: number) => {
      const { run } = await startRun({ registry, store }, request({ jobKey: job.key, input: { n }, dedupeKey: undefined }));
      await executor.submit(run.id);
      return run;
    };
    try {
      await start(bulk, 1);
      await until(async () => ran.includes('bulk 1'), 'the bulk pool to fill');
      const queuedBehindBulk = await start(bulk, 2);
      const u = await start(urgent, 1);
      await until(async () => (await store.getRun(u.id)).status === 'completed', 'the urgent run');
      // The bulk pool is full (one in flight), so its second run waits; the urgent pool ran regardless.
      expect(ran).toEqual(['bulk 1', 'urgent 1']);
      releaseBulk();
      await until(async () => ran.includes('bulk 2'), 'the second bulk run');
      releaseBulk();
      await until(async () => (await store.getRun(queuedBehindBulk.id)).status === 'completed', 'bulk 2 to finish');
    } finally {
      releaseBulk();
      await executor.stop();
    }
  });
});
