import { describe, expect, it } from 'bun:test';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  createRegistry,
  defineJob,
  InputRefusedError,
  runToCompletion,
  step,
  waitFor,
} from '../../index.ts';
import type { Executor } from '../../ports.ts';
import { fakeClock, MemoryJobStore, recordingSink } from '../../testing.ts';
import type { JobOperatorActor } from '../job-actor.ts';
import { jobsServiceOf, readsOf } from './service-fixture.ts';

const TENANT = '0a000000-0000-4000-8000-00000000000a';
const OPERATOR: JobOperatorActor = {
  kind: 'operator',
  userId: '99999999-9999-4999-8999-999999999999',
};
const MISSING = '11111111-1111-4111-8111-111111111111';

/** Proposes versions, waits for a person to choose some, then publishes them. */
const approval = defineJob({
  key: 'toy.approval',
  input: z.object({ versions: z.array(z.string()) }),
  output: z.object({ published: z.array(z.string()) }),
  steps: (s) =>
    s
      .add('propose', step({ run: ({ input }) => input.versions }))
      .add(
        'approval',
        waitFor({
          signal: 'approve',
          value: z.object({ publish: z.array(z.string()) }),
          description: 'Choose the versions to publish',
          accept: ({ publish }, { propose }) => {
            if (!publish.every((id) => propose.includes(id)))
              throw new InputRefusedError(
                'not_proposed',
                'Only a proposed version can be published',
              );
          },
        }),
      )
      .add(
        'publish',
        step({ run: ({ approval: a }) => ({ published: a.publish }) }),
      ),
});

async function setup() {
  const registry = createRegistry([approval]);
  const clock = fakeClock();
  const store = new MemoryJobStore({ now: clock.now });
  const submitted: string[] = [];
  const executor: Executor = {
    async submit(runId) {
      submitted.push(runId);
    },
    async start() {},
    async stop() {},
  };
  const sink = recordingSink();
  const service = jobsServiceOf({
    registry,
    store,
    executor,
    clock,
    events: sink,
    reads: readsOf({ listNewestRunsPerJob: async () => [] }),
  });
  const waiting = await runToCompletion(
    approval,
    {
      input: { versions: ['v1', 'v2'] },
      tenantId: TENANT,
      trigger: 'eval',
      requestedBy: null,
      budget: { maxItems: 1 },
    },
    { store, clock, executor: { pollMs: 1 } },
  );
  return { service, store, submitted, sink, runId: waiting.run.id };
}

const signal = (runId: string, value: unknown, over = {}) => ({
  runId,
  step: 'approval',
  signal: 'approve',
  value,
  ...over,
});

describe('JobsService, the operator view: signal (Approve)', () => {
  it('settles the waiting step as the superuser and submits the run', async () => {
    const { service, store, submitted, sink, runId } = await setup();
    const { run } = await service.signal(
      OPERATOR,
      signal(runId, { publish: ['v1'] }),
    );
    expect(run.status).toBe('running');
    expect(submitted).toEqual([runId]);
    expect(
      (await store.stepStates(runId)).find((s) => s.name === 'approval'),
    ).toMatchObject({ status: 'completed', settledBy: OPERATOR.userId });
    expect(sink.events.map((e) => e.type)).toContain('step.signaled');
  });

  it('refuses each way, with its code and never the value', async () => {
    const { service, runId } = await setup();
    const thrown = (p: Promise<unknown>) => p.catch((e: unknown) => e);

    const invalid = await thrown(
      service.signal(OPERATOR, signal(runId, { publish: 'secret-text' })),
    );
    expect(invalid).toBeInstanceOf(BadRequestException);
    const body = (invalid as BadRequestException).getResponse();
    expect(body).toMatchObject({
      code: 'signal_value_invalid',
      issues: [{ path: 'publish', code: 'invalid_type' }],
    });
    expect(JSON.stringify(body)).not.toContain('secret-text');

    const refused = await thrown(
      service.signal(OPERATOR, signal(runId, { publish: ['v9'] })),
    );
    expect(refused).toBeInstanceOf(BadRequestException);
    expect((refused as BadRequestException).getResponse()).toMatchObject({
      code: 'not_proposed',
    });

    const other = await thrown(
      service.signal(
        OPERATOR,
        signal(runId, { publish: [] }, { signal: 'reject' }),
      ),
    );
    expect(other).toBeInstanceOf(ConflictException);
    expect((other as ConflictException).getResponse()).toMatchObject({
      code: 'wait_not_open',
    });

    await service.signal(OPERATOR, signal(runId, { publish: ['v1'] }));
    // The first signal wins.
    const again = await thrown(
      service.signal(OPERATOR, signal(runId, { publish: ['v2'] })),
    );
    expect(again).toBeInstanceOf(ConflictException);

    const missing = await thrown(
      service.signal(OPERATOR, signal(MISSING, { publish: [] })),
    );
    expect(missing).toBeInstanceOf(NotFoundException);
  });

  it("lists a wait step's signal with the form its value is asked with", async () => {
    const { service } = await setup();
    const { jobs } = await service.listJobsWithHealth(OPERATOR);
    const wait = jobs[0]?.steps.find((s) => s.name === 'approval');
    expect(wait).toMatchObject({
      kind: 'wait',
      batchMax: null,
      signal: {
        name: 'approve',
        description: 'Choose the versions to publish',
        authority: null,
        // An array of ids has no form control yet: Approve edits it as JSON, as Start run does.
        value: { kind: 'json' },
        timeout: null,
      },
    });
    expect(jobs[0]?.steps[0]).toMatchObject({ kind: 'step', signal: null });
  });
});
