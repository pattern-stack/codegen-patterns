import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { MemoryJobStore } from '../../adapters/memory-store.ts';
import { memorySweepCursors } from '../../adapters/memory-sweep-cursors.ts';
import { defineJob } from '../../define/define-job.ts';
import { createRegistry } from '../../define/registry.ts';
import { step } from '../../define/step.ts';
import { startRun } from '../../engine/start-run.ts';
import type { SweepCursors } from '../../ports/sweep-cursors.ts';
import { BullmqExecutor } from '../bullmq-executor.ts';
import type { JobEngineQueue } from '../job-data.ts';

const job = defineJob({
  key: 'toy.swept',
  input: z.object({ n: z.number() }),
  output: z.number(),
  steps: (s) => s.add('n', step({ run: ({ input }) => input.n })),
});

/** A queue that records which runs each sweep resubmitted. */
const recordingQueue = () => {
  const runs: string[] = [];
  const queue: JobEngineQueue = {
    async add(_name, data) {
      if ('runId' in data) runs.push(data.runId);
      return undefined;
    },
  };
  return { queue, runs };
};

async function openRuns(store: MemoryJobStore, n: number): Promise<string[]> {
  const registry = createRegistry([job]);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { run } = await startRun(
      { registry, store },
      {
        jobKey: job.key,
        input: { n: i },
        tenantId: 'tenant-sweep',
        trigger: 'eval',
        requestedBy: null,
        budget: { maxItems: 1 },
      },
    );
    ids.push(run.id);
  }
  return ids;
}

/** Three sweeps, alternating between two workers: which runs did they resubmit? */
async function alternating(cursors: (worker: 'a' | 'b') => SweepCursors) {
  const store = new MemoryJobStore();
  const ids = await openRuns(store, 5);
  const registry = createRegistry([job]);
  const a = recordingQueue();
  const b = recordingQueue();
  const options = (w: 'a' | 'b') => ({
    sweepRuns: 2,
    sweepCursors: cursors(w),
  });
  const workerA = new BullmqExecutor(a.queue, store, registry, options('a'));
  const workerB = new BullmqExecutor(b.queue, store, registry, options('b'));
  await workerA.sweep();
  await workerB.sweep();
  await workerA.sweep();
  return { ids, swept: new Set([...a.runs, ...b.runs]) };
}

describe('the sweep is fair across processes', () => {
  test('sharing cursors, three sweeps on two workers resubmit every one of five open runs, two per page', async () => {
    const shared = memorySweepCursors();
    const { ids, swept } = await alternating(() => shared);
    expect([...swept].sort()).toEqual([...ids].sort());
  });

  test('each worker on its own cursor goes over the same page twice and misses a run', async () => {
    const own = { a: memorySweepCursors(), b: memorySweepCursors() };
    const { ids, swept } = await alternating((w) => own[w]);
    expect(swept.size).toBeLessThan(ids.length);
  });
});
