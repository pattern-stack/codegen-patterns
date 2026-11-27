import { describe, expect, it } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import {
  children,
  createRegistry,
  defineJob,
  InProcessExecutor,
  startRun,
  step,
} from '../../index.ts';
import type { Executor } from '../../ports.ts';
import { fakeClock, MemoryJobStore, recordingSink } from '../../testing.ts';
import type { JobOperatorActor } from '../job-actor.ts';
import { jobsServiceOf } from './service-fixture.ts';

const OPERATOR: JobOperatorActor = {
  kind: 'operator',
  userId: '99999999-9999-4999-8999-999999999999',
};

const TENANT = '0a000000-0000-4000-8000-00000000000a';
let failures = 0;

const flaky = defineJob({
  key: 'toy.flaky',
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
  steps: (s) =>
    s.add(
      'run',
      step({
        retry: {
          initialIntervalMs: 1,
          backoffCoefficient: 1,
          maximumAttempts: 1,
        },
        run: ({ input }) => {
          if (input.n === 2 && failures-- > 0) throw new Error('toy');
          return { n: input.n };
        },
      }),
    ),
});

const parent = defineJob({
  key: 'toy.flaky-parent',
  input: z.object({}),
  output: z.unknown(),
  steps: (s) =>
    s.add(
      'kids',
      children({
        job: flaky,
        each: () => [
          { key: 'one', input: { n: 1 } },
          { key: 'two', input: { n: 2 } },
        ],
      }),
    ),
});

async function until(done: () => Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('timed out');
}

async function setup() {
  failures = 1;
  const registry = createRegistry([parent, flaky]);
  const clock = fakeClock();
  const store = new MemoryJobStore({ now: clock.now });
  const engine = new InProcessExecutor({ store, registry, clock, pollMs: 1 });
  await engine.start();
  const executor: Executor = engine;
  const sink = recordingSink();
  const service = jobsServiceOf({
    registry,
    store,
    executor,
    clock,
    events: sink,
  });
  const { run } = await startRun(
    { registry, store },
    {
      jobKey: parent.key,
      input: {},
      tenantId: TENANT,
      trigger: 'eval',
      requestedBy: null,
      budget: { maxItems: 1 },
    },
  );
  await engine.submit(run.id);
  const kids = async () =>
    (await store.stepStates(run.id)).find((s) => s.name === 'kids');
  await until(async () => (await kids())?.counts.failed === 1);
  return { service, store, engine, runId: run.id, kids };
}

describe('JobsService, the operator view: a held child', () => {
  it('retries a failed child into its slot, and the parent carries on', async () => {
    const { service, store, engine, runId, kids } = await setup();
    const retried = await service.retryChild(OPERATOR, {
      runId,
      step: 'kids',
      key: 'two',
    });
    expect(retried.changed).toBe(true);
    expect(retried.childRunId).not.toBeNull();
    await until(async () => (await store.getRun(runId)).status === 'completed');
    expect((await kids())?.counts).toMatchObject({ done: 2, failed: 0 });
    // The slot is no longer failed: a second retry changes nothing.
    expect(
      await service.retryChild(OPERATOR, { runId, step: 'kids', key: 'two' }),
    ).toEqual({ changed: false, childRunId: null });
    expect((await service.loadRunRecord(OPERATOR, runId)).treeSpend).toEqual({
      calls: 0,
      inputTokens: 0,
      costUsd: 0,
    });
    await engine.stop();
  });

  it('skips a failed child; a step that starts no children is refused', async () => {
    const { service, store, engine, runId } = await setup();
    expect(
      (await service.skipChild(OPERATOR, { runId, step: 'kids', key: 'two' }))
        .changed,
    ).toBe(true);
    await until(async () => (await store.getRun(runId)).status === 'completed');
    await expect(
      service.skipChild(OPERATOR, { runId, step: 'nope', key: 'two' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await engine.stop();
  });
});
