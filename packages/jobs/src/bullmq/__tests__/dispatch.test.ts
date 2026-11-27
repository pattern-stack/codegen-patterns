import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { MemoryJobStore } from '../../adapters/memory-store.ts';
import { defineJob } from '../../define/define-job.ts';
import { mapStep } from '../../define/map-step.ts';
import { createRegistry } from '../../define/registry.ts';
import { step } from '../../define/step.ts';
import { startRun } from '../../engine/start-run.ts';
import { BullmqExecutor } from '../bullmq-executor.ts';
import {
  JOB_ENGINE_JOBS,
  type JobEngineJob,
  type JobEngineQueue,
} from '../job-data.ts';

/**
 * BullMQ as far as the executor sees it, in memory: one job at a time in order, a chunk job id or an advance's
 * deduplication id dropped while a job with it waits.
 */
function memoryQueue() {
  const waiting: (JobEngineJob & { id: string })[] = [];
  const stats = { chunkAdds: 0 };
  const queue: JobEngineQueue = {
    async add(name, data, opts) {
      if (name === JOB_ENGINE_JOBS.chunk) stats.chunkAdds++;
      const id =
        opts?.jobId ?? opts?.deduplication?.id ?? `${name}-${Math.random()}`;
      if (waiting.some((j) => j.id === id)) return undefined;
      waiting.push({ id, name, data });
      return undefined;
    },
  };
  return { queue, waiting, stats };
}

const CHUNKS = 200;

const job = defineJob({
  key: 'toy.dispatched',
  input: z.object({}),
  output: z.object({ n: z.number() }),
  steps: (s) =>
    s
      .add(
        'score',
        mapStep({
          items: () => Array.from({ length: CHUNKS }, (_, i) => String(i)),
          key: (r) => r,
          run: async (batch) => batch.map(() => 1),
          batch: { max: 1 },
          limiter: 'toy',
        }),
      )
      .add('n', step({ run: ({ score }) => ({ n: score.results.length }) })),
});

describe('dispatch', () => {
  test('each chunk is enqueued about once over a run, not once per advance', async () => {
    const store = new MemoryJobStore();
    const registry = createRegistry([job]);
    const { queue, waiting, stats } = memoryQueue();
    const executor = new BullmqExecutor(queue, store, registry, {
      dispatchWindow: 8,
    });
    const { run } = await startRun(
      { registry, store },
      {
        jobKey: job.key,
        input: {},
        tenantId: 'tenant-dispatch',
        trigger: 'eval',
        requestedBy: null,
        budget: { maxItems: CHUNKS },
        chunkSize: 1,
      },
    );
    await executor.submit(run.id);
    for (let handled = 0; waiting.length && handled < 20 * CHUNKS; handled++) {
      const next = waiting.shift();
      if (next) await executor.handle(next);
    }
    expect((await store.getRun(run.id)).status).toBe('completed');
    // Re-enqueueing every pending chunk on every advance is about CHUNKS² / 2 adds.
    expect(stats.chunkAdds).toBe(CHUNKS);
  });
});
