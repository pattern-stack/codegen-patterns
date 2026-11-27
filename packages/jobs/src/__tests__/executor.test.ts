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
