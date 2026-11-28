import { describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import {
  createRegistry,
  defineJob,
  type ItemPresenter,
  mapStep,
  runToCompletion,
  step,
} from '../../index.ts';
import type { Executor } from '../../ports.ts';
import type { OperatorItem } from '../../postgres.ts';
import { fakeClock, MemoryJobStore, recordingSink } from '../../testing.ts';
import type { JobOperatorActor } from '../job-actor.ts';
import { JobInputRefRegistry, type JobInputRefs } from '../job-input-refs.ts';
import { jobsServiceOf, readsOf } from './service-fixture.ts';

const TENANT = '0a000000-0000-4000-8000-00000000000a';
const operator: JobOperatorActor = {
  kind: 'operator',
  userId: '99999999-9999-4999-8999-999999999999',
};

const Result = z.object({ name: z.string(), picks: z.array(z.string()) });
type Result = z.infer<typeof Result>;

/** A one-map-step job whose items read as `present` says. */
const jobWith = (present?: ItemPresenter<Result>) =>
  defineJob({
    key: 'toy.items',
    input: z.object({}),
    output: z.number(),
    steps: (s) =>
      s
        .add(
          'extract',
          mapStep({
            items: () => ['acc-1', 'acc-2'],
            key: (ref) => `v1:${ref}`,
            run: async (batch) =>
              batch.map((b) => ({
                name: `Account ${b.ref}`,
                picks: ['netsuite'],
              })),
            result: Result,
            batch: { max: 2 },
            limiter: 'toy',
            present,
          }),
        )
        .add('n', step({ run: ({ extract }) => extract.results.length })),
  });

async function setup(present?: ItemPresenter<Result>, refs?: JobInputRefs) {
  const job = jobWith(present);
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
  const stored: OperatorItem[] = (await store.items(run.id, 'extract')).map(
    (i) => ({
      ordinal: i.ordinal,
      chunkIndex: i.chunkIndex,
      key: i.key,
      ref: i.ref,
      status: i.status,
      attempts: i.attempts,
      errorType: i.errorType,
    }),
  );
  // A failed item that kept no result.
  const failed: OperatorItem = {
    ordinal: 2,
    chunkIndex: 0,
    key: 'v1:acc-3',
    ref: 'acc-3',
    status: 'failed',
    attempts: 3,
    errorType: 'ThrottledError',
  };
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
    reads: readsOf({ listRunItems: async () => [failed, ...stored] }),
    ...(refs ? { refs } : {}),
  });
  const warn = mock((_message: string) => {});
  Object.assign(service, { logger: { warn } });
  const page = await service.listRunItems(operator, {
    runId: run.id,
    step: 'extract',
    limit: 20,
  });
  return { page, warn };
}

describe('JobsService, the operator view: item views', () => {
  it("runs the step's present over each stored result, and carries the result and the error", async () => {
    const seen: unknown[] = [];
    const { page, warn } = await setup((item) => {
      seen.push(item.result);
      return item.result
        ? {
            label: item.result.name,
            summary: `→ ${item.result.picks.join(', ')}`,
            detail: item.result.picks.map((p) => ({
              heading: p,
              quote: 'evidence',
            })),
          }
        : { label: `${item.key} · ${item.error?.kind ?? 'no result'}` };
    });
    const [failed, first] = page.items;
    expect(failed).toMatchObject({
      key: 'v1:acc-3',
      status: 'failed',
      result: null,
      error: { kind: 'ThrottledError' },
      view: { label: 'v1:acc-3 · ThrottledError' },
    });
    expect(failed?.error?.message).not.toContain('acc');
    expect(first).toMatchObject({
      key: 'v1:acc-1',
      ref: 'acc-1',
      status: 'done',
      error: null,
      result: { name: 'Account acc-1', picks: ['netsuite'] },
      view: {
        label: 'Account acc-1',
        summary: '→ netsuite',
        detail: [{ heading: 'netsuite', quote: 'evidence' }],
      },
    });
    expect(seen).toContainEqual({ name: 'Account acc-1', picks: ['netsuite'] });
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to view null with no presenter, and says nothing', async () => {
    const { page, warn } = await setup();
    expect(page.items.map((i) => i.view)).toEqual([null, null, null]);
    expect(page.items[1]?.result).toEqual({
      name: 'Account acc-1',
      picks: ['netsuite'],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to view null when present throws, warning once for the step', async () => {
    const { page, warn } = await setup(() => {
      throw new TypeError('bad presenter');
    });
    expect(page.items.map((i) => i.view)).toEqual([null, null, null]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('TypeError');
  });

  it('falls back to view null when the answer fails itemViewSchema, warning once', async () => {
    const { page, warn } = await setup(() => ({ label: '' }));
    expect(page.items.map((i) => i.view)).toEqual([null, null, null]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("looks up the records each view names in the run's tenant, once per kind for the page", async () => {
    const OBS_1 = '11111111-1111-4111-8111-111111111111';
    const OBS_2 = '22222222-2222-4222-8222-222222222222';
    const GONE = '33333333-3333-4333-8333-333333333333';
    const resolve = mock(
      async (tenantId: string, ids: readonly string[]) =>
        tenantId === TENANT
          ? ids
              .filter((id) => id !== GONE)
              .map((id) => ({
                id,
                label: `said ${id.slice(0, 1)}`,
                hint: 'pain · 2026-11-20',
              }))
          : [],
    );
    const refs = new JobInputRefRegistry();
    refs.register({ kind: 'observation', label: 'observation', resolve });
    const { page } = await setup(
      (item) => ({
        label: item.key,
        detail: item.result
          ? [
              {
                heading: 'Wrote',
                refs: {
                  kind: 'observation',
                  ids: item.ref === 'acc-1' ? [OBS_1, GONE, OBS_1] : [OBS_2],
                },
              },
              // A kind this build doesn't know: shown as not found, never a failure.
              { heading: 'Elsewhere', refs: { kind: 'mystery', ids: [OBS_2] } },
            ]
          : undefined,
      }),
      refs,
    );
    const [failed, first, second] = page.items;
    expect(failed?.records).toEqual([]);
    expect(first?.records).toEqual([
      {
        kind: 'observation',
        id: OBS_1,
        label: 'said 1',
        hint: 'pain · 2026-11-20',
      },
    ]);
    expect(second?.records).toEqual([
      {
        kind: 'observation',
        id: OBS_2,
        label: 'said 2',
        hint: 'pain · 2026-11-20',
      },
    ]);
    expect(first?.view?.detail?.[0]?.refs?.ids).toEqual([OBS_1, GONE, OBS_1]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toBe(TENANT);
    expect([...(resolve.mock.calls[0]?.[1] ?? [])].sort()).toEqual(
      [OBS_1, GONE, OBS_2].sort(),
    );
  });

  it('answers no records, and looks nothing up, when no view names any', async () => {
    const resolve = mock(async () => []);
    const refs = new JobInputRefRegistry();
    refs.register({ kind: 'observation', label: 'observation', resolve });
    const { page } = await setup((item) => ({ label: item.key }), refs);
    expect(page.items.map((i) => i.records)).toEqual([[], [], []]);
    expect(resolve).not.toHaveBeenCalled();
  });
});
