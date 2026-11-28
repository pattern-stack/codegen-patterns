import { describe, test } from 'bun:test';
import { MemoryJobStore } from '../adapters/memory-store.ts';
import { SYSTEM_TENANT } from '../model/tenant.ts';
import { executorContract } from '../testing/executor-contract.ts';

// JOBS-3's executor changes on the memory store, two executors over it acting as two processes. The Postgres store
// runs the same contract in codegen's test-integration job.
describe('executorContract on the memory store', () => {
  for (const c of executorContract(() => ({
    store: new MemoryJobStore(),
    tenants: [SYSTEM_TENANT, 'tenant-b'],
  })))
    test(c.name, c.run, 20_000);
});

import { expect } from 'bun:test';
import { z } from 'zod';
import { defineJob } from '../define/define-job.ts';
import { createRegistry } from '../define/registry.ts';
import { step } from '../define/step.ts';
import { startRun } from '../engine/start-run.ts';

// JOBS-3's change 3: a run always has a tenant. A single-tenant app and system work use SYSTEM_TENANT, never null, so
// the one-open-run-per-dedupe-key rule holds for them as for any tenant.
describe('the tenant', () => {
  const job = defineJob({
    key: 'tenant.toy',
    input: z.object({}),
    output: z.object({}),
    steps: (s) => s.add('noop', step({ run: async () => ({}) })),
  });
  const registry = createRegistry([job]);
  const request = (tenantId: unknown) => ({
    jobKey: job.key,
    input: {},
    tenantId: tenantId as string,
    trigger: 'eval' as const,
    requestedBy: null,
    budget: { maxItems: 10 },
    dedupeKey: 'one',
  });

  test('a start without a tenant is refused, creating nothing', async () => {
    const store = new MemoryJobStore();
    for (const missing of [null, undefined, ''])
      await expect(startRun({ registry, store }, request(missing))).rejects.toThrow(/SYSTEM_TENANT/);
    expect(await store.openRunIds(10)).toEqual([]);
  });

  test('two starts under SYSTEM_TENANT with one dedupe key join one run', async () => {
    const store = new MemoryJobStore();
    const first = await startRun({ registry, store }, request(SYSTEM_TENANT));
    const second = await startRun({ registry, store }, request(SYSTEM_TENANT));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
  });
});

import { InProcessExecutor } from '../adapters/in-process-executor.ts';

// Review #969: one failed store call must not stop the in-process loop for good.
describe('the in-process loop outlives a failed poll', () => {
  test('claimChunks and sweepExpired each throw once; the loop reports it and a run still completes', async () => {
    const job = defineJob({
      key: 'loop.toy',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      steps: (s) => s.add('noop', step({ run: async () => ({ ok: true }) })),
    });
    const registry = createRegistry([job]);
    const store = new MemoryJobStore();
    const failOnce = (name: 'claimChunks' | 'sweepExpired') => {
      const real = store[name].bind(store) as (...a: unknown[]) => Promise<unknown>;
      let thrown = false;
      (store as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        if (thrown) return real(...args);
        thrown = true;
        return Promise.reject(new Error(`${name}: connection dropped`));
      };
    };
    failOnce('sweepExpired');
    failOnce('claimChunks');
    const warnings: string[] = [];
    const executor = new InProcessExecutor({ store, registry, pollMs: 1, warn: (m) => warnings.push(m) });
    await executor.start();
    const { run } = await startRun(
      { registry, store },
      { jobKey: job.key, input: {}, tenantId: SYSTEM_TENANT, trigger: 'eval', requestedBy: null, budget: { maxItems: 1 } },
    );
    await executor.submit(run.id);
    for (let i = 0; i < 500 && (await store.getRun(run.id)).status !== 'completed'; i++)
      await new Promise((r) => setTimeout(r, 2));
    await executor.stop();
    expect((await store.getRun(run.id)).status).toBe('completed');
    expect(warnings.some((w) => w.includes('sweepExpired: connection dropped'))).toBe(true);
    expect(executor.error).toBeNull();
  });
});

describe('the in-process loop stops at once', () => {
  test('a stop that lands during a poll ends the loop without waiting out pollMs (review #969 follow-up)', async () => {
    const job = defineJob({
      key: 'loop.stop',
      input: z.object({}),
      output: z.object({}),
      steps: (s) => s.add('noop', step({ run: async () => ({}) })),
    });
    const store = new MemoryJobStore();
    let release: () => void = () => {};
    const real = store.sweepExpired.bind(store);
    // The first poll is held until the stop is in flight, then fails: the loop must not then sleep 60 s.
    (store as unknown as { sweepExpired: () => Promise<unknown> }).sweepExpired = () =>
      new Promise((_, reject) => {
        release = () => reject(new Error('held poll'));
      }).finally(() => {
        (store as unknown as { sweepExpired: () => Promise<unknown> }).sweepExpired = real;
      });
    const executor = new InProcessExecutor({ store, registry: createRegistry([job]), pollMs: 60_000, warn: () => {} });
    await executor.start();
    const stopped = executor.stop();
    release();
    const t0 = Date.now();
    await stopped;
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
