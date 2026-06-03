/**
 * `JobWorker.nextStepSeq` driver-shape regression (0.15.2).
 *
 * `nextStepSeq` allocates the next `job_step.seq` for a run via a raw
 * `this.db.execute(sql\`SELECT COALESCE(MAX(seq),0)+1 ...\`)`. The result shape
 * of `db.execute(sql)` is driver-dependent and NOT uniformly array-iterable:
 * `drizzle-orm/node-postgres` returns the pg `Result` OBJECT (`{ rows, rowCount,
 * ... }`), which is not an array. The original code array-destructured the raw
 * result (`const [row] = await this.db.execute(...)`), so under node-postgres it
 * threw `TypeError: {} is not iterable` — first hit by package-mode bridge
 * deliveries, whose wrapper `@framework/bridge_delivery` run calls `ctx.step`
 * (→ `nextStepSeq`) and so failed every attempt, deadlocking the delivery.
 *
 * The fix normalises the result to a row array BEFORE reading, so both the
 * node-postgres `{ rows }` shape and a plain-array shape work. These tests pin
 * that `nextStepSeq` is shape-tolerant and never array-destructures the raw
 * result.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';

import { JobWorker } from '../../../../runtime/subsystems/jobs/job-worker';

/**
 * Build a `JobWorker` with a stub `db` whose `execute` returns `shape`. Only
 * `nextStepSeq` (which reads `this.db.execute`) is exercised; the worker's
 * polling/sweeper timers are never started (we don't call `onModuleInit`).
 */
function workerWithExecuteResult(shape: unknown): JobWorker {
  const db = {
    execute: () => Promise.resolve(shape),
  } as unknown as ConstructorParameters<typeof JobWorker>[0];
  // The remaining constructor args are unused by nextStepSeq.
  return new JobWorker(
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

/** Invoke the private `nextStepSeq` without widening its visibility in source. */
function nextStepSeq(worker: JobWorker, runId: string): Promise<number> {
  return (
    worker as unknown as { nextStepSeq(id: string): Promise<number> }
  ).nextStepSeq(runId);
}

describe('JobWorker.nextStepSeq — driver-shape tolerance (0.15.2)', () => {
  it('reads the next seq from the node-postgres { rows: [...] } result (no `{} is not iterable`)', async () => {
    const worker = workerWithExecuteResult({ rows: [{ next: 7 }], rowCount: 1 });
    await expect(nextStepSeq(worker, 'run-1')).resolves.toBe(7);
  });

  it('reads the next seq from a plain-array result shape', async () => {
    const worker = workerWithExecuteResult([{ next: 4 }]);
    await expect(nextStepSeq(worker, 'run-1')).resolves.toBe(4);
  });

  it('defaults to 1 when the result is an empty { rows: [] }', async () => {
    const worker = workerWithExecuteResult({ rows: [] });
    await expect(nextStepSeq(worker, 'run-1')).resolves.toBe(1);
  });

  it('does not throw on a non-iterable empty-object result (the original bug)', async () => {
    const worker = workerWithExecuteResult({});
    await expect(nextStepSeq(worker, 'run-1')).resolves.toBe(1);
  });
});
