import { describe, expect, it, mock } from 'bun:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import {
  createRegistry,
  defineJob,
  mapStep,
  NonRetryableError,
  runToCompletion,
  type StepPresenter,
  step,
} from '../../index.ts';
import type { Executor } from '../../ports.ts';
import { fakeClock, MemoryJobStore, recordingSink } from '../../testing.ts';
import type { JobOperatorActor } from '../job-actor.ts';
import { JobInputRefRegistry, type JobInputRefs } from '../job-input-refs.ts';
import { jobsServiceOf, readsOf } from './service-fixture.ts';

const TENANT = '0a000000-0000-4000-8000-00000000000a';
const operator: JobOperatorActor = {
  kind: 'operator',
  userId: '99999999-9999-4999-8999-999999999999',
};

type Count = { toAsk: number; planned: number };

/**
 * A job whose plain step `count` reads as `present` says, then a map step, then `boom`, which fails for good when
 * asked, so `after` never starts.
 */
const jobWith = (present: StepPresenter<Count> | undefined, fail: boolean) =>
  defineJob({
    key: 'toy.steps',
    input: z.object({}),
    output: z.number(),
    steps: (s) =>
      s
        .add('count', step({ run: () => ({ toAsk: 3, planned: 5 }), present }))
        .add(
          'judge',
          mapStep({
            items: () => ['a'],
            key: (ref) => ref,
            run: async (batch) => batch.map(() => 1),
            batch: { max: 1 },
            limiter: 'toy',
          }),
        )
        .add(
          'boom',
          step({
            run: ({ count }) => {
              if (fail) throw new NonRetryableError('no');
              return count.toAsk;
            },
            present: ({ status, error }) => ({
              summary: `${status}${error ? ` · ${error.kind}` : ''}`,
            }),
          }),
        )
        .add('after', step({ run: ({ boom }) => boom })),
  });

async function setup(
  present?: StepPresenter<Count>,
  { fail = false, refs }: { fail?: boolean; refs?: JobInputRefs } = {},
) {
  const job = jobWith(present, fail);
  const clock = fakeClock();
  const store = new MemoryJobStore({ now: clock.now });
  const { run } = await runToCompletion(
    job,
    {
      input: {},
      tenantId: TENANT,
      trigger: 'eval',
      requestedBy: null,
      budget: { maxItems: 10 },
    },
    { store, clock },
  );
  const executor: Executor = {
    submit: async () => {},
    start: async () => {},
    stop: async () => {},
  };
  const service = jobsServiceOf({
    registry: createRegistry([job]),
    store,
    executor,
    clock,
    events: recordingSink(),
    reads: readsOf({}),
    ...(refs ? { refs } : {}),
  });
  const warn = mock((_message: string) => {});
  Object.assign(service, { logger: { warn } });
  return { service, run, warn };
}

const countView: StepPresenter<Count> = ({ output }) =>
  output && {
    summary: `${output.toAsk} to ask of ${output.planned}`,
    detail: [{ heading: 'judge', text: 'gemini · low' }],
  };

const thrown = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err;
  }
  return undefined;
};

describe('JobsService, the operator view: step views', () => {
  it("gives a completed plain step's summary on the run record, and none to a map step", async () => {
    const { service, run, warn } = await setup(countView);
    const record = await service.loadRunRecord(operator, run.id);
    const summaries = Object.fromEntries(
      record.run.steps.map((s) => [s.name, s.summary]),
    );
    expect(summaries).toEqual({
      count: '3 to ask of 5',
      judge: null,
      boom: 'completed',
      after: null,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("loadStepOutput answers the step's view, its stored output and no error", async () => {
    const { service, run } = await setup(countView);
    expect(await service.loadStepOutput(operator, run.id, 'count')).toEqual({
      view: {
        summary: '3 to ask of 5',
        detail: [{ heading: 'judge', text: 'gemini · low' }],
      },
      output: { toAsk: 3, planned: 5 },
      error: null,
      records: [],
    });
  });

  it("loadStepOutput looks up the records its view names, in the run's tenant", async () => {
    const OBS = '11111111-1111-4111-8111-111111111111';
    const refs = new JobInputRefRegistry();
    refs.register({
      kind: 'observation',
      label: 'observation',
      resolve: async (tenantId, ids) =>
        tenantId === TENANT
          ? ids.map((id) => ({ id, label: 'Budget is approved', hint: null }))
          : [],
    });
    const { service, run } = await setup(
      ({ output }) =>
        output && {
          summary: 'wrote 1',
          detail: [
            { heading: 'Wrote', refs: { kind: 'observation', ids: [OBS] } },
          ],
        },
      { refs },
    );
    const opened = await service.loadStepOutput(operator, run.id, 'count');
    expect(opened.records).toEqual([
      { kind: 'observation', id: OBS, label: 'Budget is approved', hint: null },
    ]);
  });

  it('with no present: no summary, and the stored output still', async () => {
    const { service, run, warn } = await setup();
    const record = await service.loadRunRecord(operator, run.id);
    expect(record.run.steps.find((s) => s.name === 'count')?.summary).toBe(
      null,
    );
    expect(await service.loadStepOutput(operator, run.id, 'count')).toEqual({
      view: null,
      output: { toAsk: 3, planned: 5 },
      error: null,
      records: [],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('when present throws: no summary and view null, warned once per step per read, the output still', async () => {
    const { service, run, warn } = await setup(() => {
      throw new TypeError('bad presenter');
    });
    const record = await service.loadRunRecord(operator, run.id);
    expect(record.run.steps.find((s) => s.name === 'count')?.summary).toBe(
      null,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('TypeError');
    const opened = await service.loadStepOutput(operator, run.id, 'count');
    expect(opened.view).toBeNull();
    expect(opened.output).toEqual({ toAsk: 3, planned: 5 });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('when the answer fails stepViewSchema: view null, warned', async () => {
    const { service, run, warn } = await setup(() => ({ summary: '' }));
    const opened = await service.loadStepOutput(operator, run.id, 'count');
    expect(opened.view).toBeNull();
    expect(opened.output).toEqual({ toAsk: 3, planned: 5 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('stepViewSchema');
  });

  it('a step not yet completed: no summary; opened, output null and the presenter sees its status and error', async () => {
    const { service, run } = await setup(countView, { fail: true });
    const record = await service.loadRunRecord(operator, run.id);
    const boom = record.run.steps.find((s) => s.name === 'boom');
    expect(boom?.status).toBe('failed');
    expect(boom?.summary).toBeNull();
    expect(await service.loadStepOutput(operator, run.id, 'boom')).toEqual({
      view: { summary: 'failed · NonRetryableError' },
      output: null,
      error: { kind: 'NonRetryableError', message: expect.any(String) },
      records: [],
    });
    expect(await service.loadStepOutput(operator, run.id, 'after')).toEqual({
      view: null,
      output: null,
      error: null,
      records: [],
    });
  });

  it('refuses a step the job does not define (404) and a map step (400)', async () => {
    const { service, run } = await setup(countView);
    const missing = await thrown(service.loadStepOutput(operator, run.id, 'x'));
    expect(missing).toBeInstanceOf(NotFoundException);
    const map = await thrown(service.loadStepOutput(operator, run.id, 'judge'));
    expect(map).toBeInstanceOf(BadRequestException);
  });

  it('is operator-only: any other actor kind is a plain Error', async () => {
    const { service, run } = await setup(countView);
    const member = {
      kind: 'member',
      tenantId: TENANT,
      userId: operator.userId,
    };
    const err = await thrown(
      service.loadStepOutput(member as never, run.id, 'count'),
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotFoundException);
  });
});
