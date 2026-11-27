import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { InProcessExecutor } from '../adapters/in-process-executor.ts';
import { systemClock } from '../adapters/system-clock.ts';
import { defineJob } from '../define/define-job.ts';
import { mapStep } from '../define/map-step.ts';
import { createRegistry } from '../define/registry.ts';
import { step, waitFor } from '../define/step.ts';
import { signalRun } from '../engine/signals.ts';
import { startRun } from '../engine/start-run.ts';
import { TERMINAL_RUN, type Run } from '../model/run.ts';
import type { JobStore } from '../ports/job-store.ts';
import type { RunScope } from '../ports/run-scope.ts';
import type { ContractCase } from './contract.ts';

/** A store several in-process executors share, as several processes would. Every call makes a fresh, empty store. */
export interface ExecutorHarness {
  store: JobStore;
  /** Two tenants the store can hold runs for. */
  tenants: [string, string];
}

/** Polls until `check` holds or `ms` pass; real time, as executors on a shared store run on it. */
async function until(check: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const ended = (store: JobStore, runId: string) => async () =>
  TERMINAL_RUN.includes((await store.getRun(runId)).status);

/** Fast loops: a poll and an open sweep every 10 ms, claims and leases that lapse in 300 ms. */
const fast = { pollMs: 10, openSweepEvery: 1, claimTtlMs: 300 } as const;

/**
 * What the in-process executor owes a store that more than one process drives (JOBS-3's changes 1, 2 and 4): a
 * restarted process resumes a run it was never handed; a run another process created is found; two executors never
 * run one step's code at once (when the store has `runLeases`); job code runs inside the run's scope.
 */
export function executorContract(make: () => ExecutorHarness): ContractCase[] {
  const cases: ContractCase[] = [];
  const it = (name: string, run: () => Promise<void>) => cases.push({ name, run });

  it('kill and restart: a fresh executor, never handed the run, resumes it and completes it', async () => {
    const { store, tenants } = make();
    let attempts = 0;
    const job = defineJob({
      key: 'contract.restart',
      input: z.object({}),
      output: z.object({ attempt: z.number() }),
      steps: (s) =>
        s.add(
          'work',
          step({
            run: async (ctx) => {
              attempts++;
              // The first attempt hangs until its process dies; the one after the restart finishes.
              if (attempts === 1)
                await new Promise<void>((_, reject) =>
                  ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)),
                );
              return { attempt: attempts };
            },
          }),
        ),
    });
    const registry = createRegistry([job]);
    const a = new InProcessExecutor({ store, registry, ...fast, owner: 'a' });
    await a.start();
    const { run } = await startRun({ registry, store }, { jobKey: job.key, input: {}, tenantId: tenants[0], trigger: 'eval', requestedBy: null, budget: { maxItems: 100 } });
    await a.submit(run.id);
    await until(async () => attempts === 1, 5_000, 'the first attempt to start');
    await a.kill();
    assert.equal((await store.getRun(run.id)).status, 'running');

    const b = new InProcessExecutor({ store, registry, ...fast, owner: 'b' });
    await b.start();
    try {
      await until(ended(store, run.id), 10_000, 'the restarted executor to finish the run');
    } finally {
      await b.stop();
    }
    assert.equal((await store.getRun(run.id)).status, 'completed');
    assert.equal(attempts, 2);
  });

  it('a run another process created, and never submitted, is found and completed', async () => {
    const { store, tenants } = make();
    const job = defineJob({
      key: 'contract.found',
      input: z.object({ n: z.number() }),
      output: z.object({ n: z.number() }),
      steps: (s) => s.add('double', step({ run: async ({ input }) => ({ n: input.n * 2 }) })),
    });
    const registry = createRegistry([job]);
    // The "other process": a start with no executor at all (a bridge's start inside its transaction).
    const { run } = await startRun({ registry, store }, { jobKey: job.key, input: { n: 21 }, tenantId: tenants[0], trigger: 'event', requestedBy: null, budget: { maxItems: 100 } });
    const executor = new InProcessExecutor({ store, registry, ...fast });
    await executor.start();
    try {
      await until(ended(store, run.id), 5_000, 'the sweep to find the run');
    } finally {
      await executor.stop();
    }
    assert.equal((await store.getRun(run.id)).status, 'completed');
  });

  it('two executors over one store: a slow plain step runs once, not once per replica', async () => {
    const { store, tenants } = make();
    if (!store.runLeases) return; // A store without leases runs one in-process executor; nothing to hold.
    let runs = 0;
    const job = defineJob({
      key: 'contract.replicas',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      steps: (s) =>
        s.add(
          'slow',
          step({
            run: async () => {
              runs++;
              await new Promise((r) => setTimeout(r, 400));
              return { ok: true };
            },
          }),
        ),
    });
    const registry = createRegistry([job]);
    const a = new InProcessExecutor({ store, registry, ...fast, owner: 'a' });
    const b = new InProcessExecutor({ store, registry, ...fast, owner: 'b' });
    await a.start();
    await b.start();
    try {
      const { run } = await startRun({ registry, store }, { jobKey: job.key, input: {}, tenantId: tenants[0], trigger: 'eval', requestedBy: null, budget: { maxItems: 100 } });
      await a.submit(run.id);
      await until(ended(store, run.id), 5_000, 'the run to finish');
      assert.equal((await store.getRun(run.id)).status, 'completed');
    } finally {
      await a.stop();
      await b.stop();
    }
    assert.equal(runs, 1);
  });

  it("job code runs in its run's scope: a plain step, a map step's batch, admit and a signal's accept", async () => {
    const { store, tenants } = make();
    const scope = new AsyncLocalStorage<string>();
    const around: RunScope = (target, fn) => scope.run(`${target.tenantId}/${target.jobKey}`, fn);
    const seen: Record<string, string | undefined> = {};
    const job = defineJob({
      key: 'contract.scope',
      input: z.object({}),
      output: z.object({ step: z.string().nullable() }),
      admit: async () => {
        seen.admit = scope.getStore();
      },
      steps: (s) =>
        s
          .add(
            'items',
            mapStep({
              items: () => ['a'],
              key: (r) => `k:${r}`,
              run: async (batch) => {
                seen.batch = scope.getStore();
                return batch.map(() => ({ ok: true }));
              },
              batch: { max: 10 },
              limiter: 'contract-calls',
            }),
          )
          .add(
            'approve',
            waitFor({
              signal: 'go',
              value: z.object({}),
              accept: async () => {
                seen.accept = scope.getStore();
              },
            }),
          )
          .add(
            'read',
            step({
              run: async () => {
                seen.step = scope.getStore();
                return { step: seen.step ?? null };
              },
            }),
          ),
    });
    const registry = createRegistry([job]);
    const executor = new InProcessExecutor({ store, registry, ...fast, around });
    await executor.start();
    let run: Run;
    try {
      ({ run } = await startRun({ registry, store, around }, { jobKey: job.key, input: {}, tenantId: tenants[1], trigger: 'eval', requestedBy: null, budget: { maxItems: 100 } }));
      await executor.submit(run.id);
      await until(async () => (await store.getRun(run.id)).status === 'waiting', 5_000, 'the run to wait');
      await signalRun(
        { store, registry, clock: systemClock, events: executor.sink, executor, around },
        { runId: run.id, step: 'approve', signal: 'go', value: {}, by: null },
      );
      await until(ended(store, run.id), 5_000, 'the run to finish');
    } finally {
      await executor.stop();
    }
    const want = `${tenants[1]}/${job.key}`;
    assert.equal((await store.getRun(run.id)).status, 'completed');
    assert.deepEqual(seen, { admit: want, batch: want, accept: want, step: want });
  });

  return cases;
}
