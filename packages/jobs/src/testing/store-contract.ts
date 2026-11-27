import assert from 'node:assert/strict';
import { runToCompletion } from '../adapters/in-process-executor.ts';
import { localLimiters } from '../adapters/local-limiter.ts';
import { createRegistry } from '../define/registry.ts';
import { startRun } from '../engine/start-run.ts';
import type { ChunkClaim } from '../model/chunk.ts';
import {
  ClaimLostError,
  JobDefinitionError,
  RunNotFoundError,
  RunPlanningError,
} from '../model/errors.ts';
import type { NewRun, Run } from '../model/run.ts';
import type { JobStore } from '../ports/job-store.ts';
import type { ContractCase } from './contract.ts';
import type { FakeClock } from './fake-clock.ts';
import { hang, ids, scoreOf, toyScoring } from './toy-jobs.ts';

/** A store under test, on a clock the suite moves. Every call makes a fresh, empty store. */
export interface StoreHarness {
  store: JobStore;
  clock: FakeClock;
  /** Two tenants the store can hold runs for (seeded rows, where the store needs them). */
  tenants: [string, string];
  /** A user the store can record as a signal's sender (a seeded row, where the store needs one). */
  user: string;
}

const STEP = 'score';
const SCOPE = `toy.contract/${STEP}`;

const newRun = (h: StoreHarness, over: Partial<NewRun> = {}): NewRun => ({
  jobKey: 'toy.contract',
  jobVersion: 'v1',
  input: h.store.keepsValues ? { n: 0 } : undefined,
  tenantId: h.tenants[0],
  trigger: 'eval',
  requestedBy: null,
  chunkSize: 10,
  budget: { maxItems: 1000 },
  ...over,
});

const page = (from: number, n: number, next: string | null) => {
  const refs = Array.from({ length: n }, (_, i) => `o${from + i}`);
  return { refs, keys: refs.map((r) => `k:${r}`), next };
};

const zero = { calls: 0, inputTokens: 0, costUsd: 0 };
const call = { calls: 1, inputTokens: 100, costUsd: 0.00001 };
/** Finished items; their results only for a store that keeps values. */
const done = (h: StoreHarness, keys: string[], p = 0.9) =>
  keys.map((key) =>
    h.store.keepsValues
      ? { key, ref: key.slice(2), result: { p } }
      : { key, ref: key.slice(2) },
  );

/** A running run with its map step started. */
async function running(h: StoreHarness, over: Partial<NewRun> = {}) {
  const { store } = h;
  const run = await createdRun(store, newRun(h, over));
  await store.transition(run.id, { to: 'running', from: 'pending' });
  await store.startStep(
    run.id,
    { name: STEP, index: 1, kind: 'map' },
    { attempts: 0 },
  );
  return run;
}

const stepOf = async (store: JobStore, run: Run) => {
  const state = (await store.stepStates(run.id)).find((s) => s.name === STEP);
  assert.ok(state, 'the map step has a state');
  return state;
};

const one = (claims: ChunkClaim[]): ChunkClaim => {
  const [claim] = claims;
  assert.ok(claim, 'a chunk was claimed');
  return claim;
};

/** The run a create returns, new or found. */
const createdRun = async (store: JobStore, req: NewRun) =>
  (await store.createRun(req)).run;

const rejectsLost = (p: Promise<unknown>) =>
  assert.rejects(p, (err) => err instanceof ClaimLostError);

/** A store that keeps no values refuses a job with a value that has no recorder, and never creates its run. */
async function assertRefusesUnrecorded(h: StoreHarness): Promise<void> {
  const { job } = toyScoring();
  await assert.rejects(
    startRun(
      { registry: createRegistry([job]), store: h.store },
      toyRequest(h, 2, job.key),
    ),
    (err) =>
      err instanceof JobDefinitionError && /no recorder/.test(err.message),
  );
  assert.deepEqual(
    await h.store.listRuns({ tenantId: h.tenants[0], limit: 100 }),
    [],
  );
}

const toyRequest = (h: StoreHarness, n: number, jobKey: string) => ({
  jobKey,
  input: { n },
  tenantId: h.tenants[0],
  trigger: 'eval' as const,
  requestedBy: null,
  budget: { maxItems: n },
});

/**
 * The job store contract. Every adapter passes the same suite, the Postgres one included:
 *  1. the first write of a result wins; 2. a lost claim is fenced; 3. counts and spend move with the items they
 *  describe; 4. a crash loses only what was in flight (held by `replayContract` and the engine's resume test).
 * Ids come from the store; dedupe holds at most one open run per tenant, job, dry or real, and key.
 */
export function storeContract(make: () => StoreHarness): ContractCase[] {
  const cases: ContractCase[] = [];
  const it = (name: string, run: () => Promise<void>) =>
    cases.push({ name, run });

  it('a page makes items, fills chunks as they fill, and plans the tail once the source ends', async () => {
    const h = make();
    const { store } = h;
    const run = await running(h);
    await store.planItems(run.id, STEP, page(0, 15, '15'));
    let state = await stepOf(store, run);
    assert.equal(state.planned, false);
    assert.equal(state.sourceCursor, '15');
    assert.equal(state.counts.total, 15);
    assert.equal(state.chunks.pending, 1);
    await store.planItems(run.id, STEP, page(15, 10, null));
    state = await stepOf(store, run);
    assert.equal(state.planned, true);
    assert.equal(state.chunks.pending, 3);
    const items = await store.items(run.id, STEP);
    assert.deepEqual(
      items.map((i) => i.chunkIndex),
      [...Array(10).fill(0), ...Array(10).fill(1), ...Array(5).fill(2)],
    );
    assert.deepEqual(
      items.map((i) => i.ordinal),
      items.map((_, i) => i),
    );
  });

  it('planning stops at maxItems, and an item is planned once per step', async () => {
    const h = make();
    const { store } = h;
    const run = await running(h, { budget: { maxItems: 12 } });
    const first = page(0, 8, '8');
    await store.planItems(run.id, STEP, {
      ...first,
      refs: [...first.refs, 'o0'],
      keys: [...first.keys, 'k:o0'],
    });
    await store.planItems(run.id, STEP, page(8, 8, '16'));
    const state = await stepOf(store, run);
    assert.equal(state.planned, true);
    assert.equal(state.counts.total, 12);
    assert.equal(state.chunks.pending, 2);
  });

  it('an open dedupeKey returns that run, within one tenant and job; a finished one starts afresh', async () => {
    const h = make();
    const { store, clock } = h;
    const first = await store.createRun(newRun(h, { dedupeKey: 'd' }));
    const a = first.run;
    assert.equal(first.created, true);
    const hit = await store.createRun(newRun(h, { dedupeKey: 'd' }));
    assert.equal(hit.run.id, a.id);
    assert.equal(hit.created, false);
    const otherTenant = await createdRun(
      store,
      newRun(h, { dedupeKey: 'd', tenantId: h.tenants[1] }),
    );
    const otherJob = await createdRun(
      store,
      newRun(h, { dedupeKey: 'd', jobKey: 'toy.other' }),
    );
    assert.notEqual(otherTenant.id, a.id);
    assert.notEqual(otherJob.id, a.id);
    await store.transition(a.id, { to: 'running', from: 'pending' });
    await store.transition(a.id, { to: 'completed' });
    clock.advance(1);
    const again = await createdRun(store, newRun(h, { dedupeKey: 'd' }));
    assert.notEqual(again.id, a.id);
    assert.equal(again.status, 'pending');
  });

  it('a dry run and a real run never answer each other on one dedupe key', async () => {
    const h = make();
    const { store } = h;
    const dry = await createdRun(
      store,
      newRun(h, { dedupeKey: 'dr', dryRun: true }),
    );
    // A real start beside an open dry run starts its own, and the reverse.
    const real = await store.createRun(newRun(h, { dedupeKey: 'dr' }));
    assert.equal(real.created, true);
    assert.notEqual(real.run.id, dry.id);
    assert.equal(real.run.dryRun, false);
    const realHit = await store.createRun(newRun(h, { dedupeKey: 'dr' }));
    assert.equal(realHit.run.id, real.run.id);
    assert.equal(realHit.created, false);
    const dryHit = await store.createRun(
      newRun(h, { dedupeKey: 'dr', dryRun: true }),
    );
    assert.equal(dryHit.run.id, dry.id);
    assert.equal(dryHit.created, false);
    assert.equal(dryHit.run.dryRun, true);
  });

  it('getRun, progress, transition and runInput of an unknown id throw RunNotFoundError', async () => {
    const { store } = make();
    const unknown = '00000000-0000-4000-8000-000000000000';
    // Thunks, so each call starts only once the one before it is settled (no rejection is left unhandled).
    for (const read of [
      () => store.getRun(unknown),
      () => store.progress(unknown),
      () => store.transition(unknown, { to: 'canceled' }),
      () => store.runInput(unknown),
    ])
      await assert.rejects(
        read,
        (err) => err instanceof RunNotFoundError && err.runId === unknown,
      );
  });

  it('a run keeps its request as created: input, version, budget and its deadline', async () => {
    const h = make();
    const { store } = h;
    const deadline = new Date('2030-01-01T00:00:00Z');
    const input = store.keepsValues ? { n: 7 } : undefined;
    const run = await createdRun(
      store,
      newRun(h, { input, dryRun: true, budget: { maxItems: 5, deadline } }),
    );
    const back = await store.getRun(run.id);
    assert.deepEqual(await store.runInput(run.id), input);
    assert.equal(back.dryRun, true);
    assert.equal(
      (await store.getRun((await createdRun(store, newRun(h))).id)).dryRun,
      false,
    );
    assert.equal(back.jobVersion, 'v1');
    assert.equal(back.budget.deadline?.toISOString(), deadline.toISOString());
    assert.equal(back.status, 'pending');
  });

  it('a new run is refused alike by every store: an empty requestedBy, a bad chunk size or budget', async () => {
    const h = make();
    for (const over of [
      { requestedBy: '' },
      { chunkSize: 0 },
      { budget: { maxItems: 1.5 } },
    ] satisfies Partial<NewRun>[])
      await assert.rejects(
        () => h.store.createRun(newRun(h, over)),
        (err) => err instanceof RunPlanningError,
      );
  });

  it('a transition a run is not in a state to take is refused, and changes nothing', async () => {
    const h = make();
    const { store } = h;
    const run = await createdRun(store, newRun(h));
    assert.equal(
      (await store.transition(run.id, { to: 'completed' })).changed,
      false,
    );
    assert.equal(
      (await store.transition(run.id, { to: 'running', from: 'pending' }))
        .changed,
      true,
    );
    assert.equal(
      (await store.transition(run.id, { to: 'running', from: 'pending' }))
        .changed,
      false,
    );
    const failed = await store.transition(run.id, {
      to: 'failed',
      error: { type: 'X', message: 'x' },
    });
    assert.equal(failed.run.status, 'failed');
    assert.deepEqual(failed.run.error, { type: 'X', message: 'x' });
    assert.ok(failed.run.completedAt);
    assert.equal(
      (await store.transition(run.id, { to: 'canceled' })).changed,
      false,
    );
  });

  it('runs list newest first, by tenant, job and status', async () => {
    const h = make();
    const { store, clock } = h;
    const a = await createdRun(store, newRun(h));
    clock.advance(1);
    const b = await createdRun(store, newRun(h, { jobKey: 'toy.other' }));
    clock.advance(1);
    await createdRun(store, newRun(h, { tenantId: h.tenants[1] }));
    assert.deepEqual(
      (
        await store.listRuns({ tenantId: h.tenants[0], limit: 100 })
      ).map((r) => r.id),
      [b.id, a.id],
    );
    assert.deepEqual(
      (
        await store.listRuns({
          tenantId: h.tenants[0],
          jobKey: 'toy.contract',
          limit: 100,
        })
      ).map((r) => r.id),
      [a.id],
    );
    await store.transition(a.id, { to: 'running', from: 'pending' });
    assert.deepEqual(
      (
        await store.listRuns({
          tenantId: h.tenants[0],
          status: 'running',
          limit: 100,
        })
      ).map((r) => r.id),
      [a.id],
    );
  });

  it('a step records its output and completes; a failed step keeps its error; a restart spends an attempt', async () => {
    const h = make();
    const { store } = h;
    const run = await createdRun(store, newRun(h));
    await store.transition(run.id, { to: 'running', from: 'pending' });
    const list = { name: 'list', index: 0, kind: 'step' } as const;
    const started = await store.startStep(run.id, list, { attempts: 0 });
    assert.equal(started?.status, 'running');
    assert.equal(started?.attempts, 1);
    assert.equal(
      (await store.startStep(run.id, list, { attempts: 1 }))?.attempts,
      2,
    );
    const output = store.keepsValues ? { refs: ['a', 'b'] } : undefined;
    await store.recordStep(run.id, 'list', { status: 'completed', output });
    assert.deepEqual(await store.stepOutput(run.id, 'list'), output);
    await store.startStep(
      run.id,
      { name: 'line', index: 2, kind: 'step' },
      { attempts: 0 },
    );
    await store.failStep(run.id, 'line', { type: 'E', message: 'e' });
    const states = await store.stepStates(run.id);
    assert.deepEqual(
      states.map((s) => [s.name, s.status]),
      [
        ['list', 'completed'],
        ['line', 'failed'],
      ],
    );
    assert.deepEqual(states[1]?.error, { type: 'E', message: 'e' });
    assert.equal(await store.stepOutput(run.id, 'line'), undefined);
  });

  it('a step starts as a CAS on its attempts: a racing start, a stale one or an ended step changes nothing', async () => {
    const h = make();
    const { store } = h;
    const run = await createdRun(store, newRun(h));
    await store.transition(run.id, { to: 'running', from: 'pending' });
    const line = { name: 'line', index: 0, kind: 'step' } as const;
    // Two advancers race on the first attempt: one starts it.
    const [one, two] = await Promise.all([
      store.startStep(run.id, line, { attempts: 0 }),
      store.startStep(run.id, line, { attempts: 0 }),
    ]);
    assert.equal([one, two].filter((s) => s !== null).length, 1);
    // A start from a stale count, and one past what the step is at, change nothing.
    assert.equal(await store.startStep(run.id, line, { attempts: 0 }), null);
    assert.equal(await store.startStep(run.id, line, { attempts: 5 }), null);
    assert.equal(
      (await store.startStep(run.id, line, { attempts: 1 }))?.attempts,
      2,
    );
    await store.recordStep(run.id, 'line', {
      status: 'completed',
      output: store.keepsValues ? 1 : undefined,
    });
    // An ended step never runs again.
    assert.equal(await store.startStep(run.id, line, { attempts: 2 }), null);
    const [state] = await store.stepStates(run.id);
    assert.equal(state?.status, 'completed');
    assert.equal(state?.attempts, 2);
  });

  it('a claim takes up to n eligible chunks of running runs, spending an attempt each', async () => {
    const h = make();
    const { store } = h;
    const run = await createdRun(store, newRun(h));
    await store.startStep(
      run.id,
      { name: STEP, index: 1, kind: 'map' },
      { attempts: 0 },
    );
    await store.planItems(run.id, STEP, page(0, 30, null));
    assert.deepEqual(await store.claimChunks('w', 5, 1000), []);
    await store.transition(run.id, { to: 'running', from: 'pending' });
    const claims = await store.claimChunks('w', 2, 1000);
    assert.deepEqual(
      claims.map((c) => [c.step, c.index, c.attempts]),
      [
        [STEP, 0, 1],
        [STEP, 1, 1],
      ],
    );
    assert.equal((await store.claimChunks('w', 5, 1000)).length, 1);
    assert.equal((await store.claimChunks('w', 5, 1000)).length, 0);
  });

  it("a claim with jobKeys takes only chunks of those jobs' runs", async () => {
    const h = make();
    const { store } = h;
    const planned = async (jobKey: string) => {
      const run = await createdRun(store, newRun(h, { jobKey }));
      await store.startStep(
        run.id,
        { name: STEP, index: 1, kind: 'map' },
        { attempts: 0 },
      );
      await store.planItems(run.id, STEP, page(0, 30, null));
      await store.transition(run.id, { to: 'running', from: 'pending' });
      return run;
    };
    await planned('toy.contract');
    const other = await planned('toy.other');
    assert.deepEqual(await store.claimChunks('w', 5, 1000, ['toy.none']), []);
    const claims = await store.claimChunks('w', 5, 1000, ['toy.other']);
    assert.equal(claims.length, 3);
    assert.ok(claims.every((c) => c.runId === other.id));
  });

  it('rule 1: the first write wins, across runs, within one tenant and scope (or, keeping no values, the store refuses a job without recorders)', async () => {
    const h = make();
    const { store } = h;
    if (!store.keepsValues) {
      await assertRefusesUnrecorded(h);
      return;
    }
    const a = await running(h);
    await store.planItems(a.id, STEP, page(0, 1, null));
    const ca = one(await store.claimChunks('w', 1, 1000));
    await store.writeResults(ca, { done: done(h, ['k:o0'], 0.9) }, call);
    const b = await running(h);
    await store.planItems(b.id, STEP, page(0, 1, null));
    const cb = one(await store.claimChunks('w', 1, 1000));
    await store.writeResults(cb, { done: done(h, ['k:o0'], 0.1) }, call);
    const hit = (
      await store.itemResults<{ p: number }>(SCOPE, h.tenants[0], [
        'k:o0',
      ])
    ).get('k:o0');
    assert.deepEqual(hit?.result, { p: 0.9 });
    assert.equal(hit?.runId, a.id);
    assert.equal(hit?.scope, SCOPE);
    assert.equal(
      (await store.itemResults(SCOPE, h.tenants[1], ['k:o0'])).size,
      0,
    );
    assert.equal(
      (
        await store.itemResults('toy.contract/other', h.tenants[0], [
          'k:o0',
        ])
      ).size,
      0,
    );
  });

  it("a refresh run's answer replaces the stored one while its claim holds; a canceled refresh's late answer never does", async () => {
    const h = make();
    const { store } = h;
    if (!store.keepsValues) return;
    const read = async () =>
      (
        await store.itemResults<{ p: number }>(SCOPE, h.tenants[0], [
          'k:o0',
        ])
      ).get('k:o0');
    const a = await running(h);
    await store.planItems(a.id, STEP, page(0, 1, null));
    await store.writeResults(
      one(await store.claimChunks('w', 1, 1000)),
      { done: done(h, ['k:o0'], 0.1) },
      call,
    );
    // A read-write run never replaces it.
    const b = await running(h);
    await store.planItems(b.id, STEP, page(0, 1, null));
    await store.writeResults(
      one(await store.claimChunks('w', 1, 1000)),
      { done: done(h, ['k:o0'], 0.2) },
      call,
    );
    assert.deepEqual((await read())?.result, { p: 0.1 });
    // A refresh does, and the result names it.
    const c = await running(h, { cache: 'refresh' });
    assert.equal(c.cache, 'refresh');
    await store.planItems(c.id, STEP, page(0, 1, null));
    await store.writeResults(
      one(await store.claimChunks('w', 1, 1000)),
      { done: done(h, ['k:o0'], 0.3) },
      call,
    );
    const now = await read();
    assert.deepEqual(now?.result, { p: 0.3 });
    assert.equal(now?.runId, c.id);
    // A refresh canceled while its call was out: the late answer lands nowhere.
    const d = await running(h, { cache: 'refresh' });
    await store.planItems(d.id, STEP, page(0, 1, null));
    const late = one(await store.claimChunks('w', 1, 1000));
    await store.transition(d.id, { to: 'canceled' });
    await rejectsLost(
      store.writeResults(late, { done: done(h, ['k:o0'], 0.4) }, call),
    );
    assert.deepEqual((await read())?.result, { p: 0.3 });
  });

  it('a run keeps the subject it was created with, and none by default', async () => {
    const h = make();
    const { store } = h;
    const about = await createdRun(
      store,
      newRun(h, { subject: { kind: 'document', id: 'iv-1' } }),
    );
    assert.deepEqual((await store.getRun(about.id)).subject, {
      kind: 'document',
      id: 'iv-1',
    });
    const plain = await createdRun(store, newRun(h));
    assert.equal((await store.getRun(plain.id)).subject, null);
  });

  it("a tenant's runs list by subject: kind and id both equal", async () => {
    const h = make();
    const { store, clock } = h;
    const subject = { kind: 'document', id: 'iv-1' };
    const a = await createdRun(store, newRun(h, { subject }));
    clock.advance(1);
    await createdRun(store, newRun(h, { subject: { ...subject, id: 'iv-2' } }));
    await createdRun(store, newRun(h, { subject: { ...subject, kind: 'x' } }));
    await createdRun(store, newRun(h));
    await createdRun(
      store,
      newRun(h, { tenantId: h.tenants[1], subject }),
    );
    clock.advance(1);
    const b = await createdRun(store, newRun(h, { subject }));
    assert.deepEqual(
      (
        await store.listRuns({
          tenantId: h.tenants[0],
          subject,
          limit: 100,
        })
      ).map((r) => r.id),
      [b.id, a.id],
    );
  });

  it("a write naming a scope keeps its results there, not under the step's own (a shared cacheScope)", async () => {
    const h = make();
    const { store } = h;
    if (!store.keepsValues) return;
    const a = await running(h);
    await store.planItems(a.id, STEP, page(0, 1, null));
    const ca = one(await store.claimChunks('w', 1, 1000));
    await store.writeResults(
      ca,
      { done: done(h, ['k:o0'], 0.7), scope: 'toy-shared' },
      call,
    );
    const hit = (
      await store.itemResults<{ p: number }>('toy-shared', h.tenants[0], [
        'k:o0',
      ])
    ).get('k:o0');
    assert.deepEqual(hit?.result, { p: 0.7 });
    assert.equal(hit?.scope, 'toy-shared');
    assert.equal(
      (await store.itemResults(SCOPE, h.tenants[0], ['k:o0'])).size,
      0,
    );
  });

  it('rule 2: a lost claim is fenced; its results and spend still land, its counts and settle do not', async () => {
    const h = make();
    const { store, clock } = h;
    const run = await running(h);
    await store.planItems(run.id, STEP, page(0, 3, null));
    const mine = one(await store.claimChunks('a', 1, 1000));
    clock.advance(2000);
    assert.equal(await store.sweepExpired(), 1);
    const theirs = one(await store.claimChunks('b', 1, 1000));
    assert.equal(theirs.owner, 'b');
    assert.equal(theirs.attempts, 2);
    const renewed = await store.renewClaim('a', [mine], 1000);
    assert.deepEqual(renewed.lost, [mine]);
    assert.equal(renewed.runs[run.id], 'running');
    await rejectsLost(
      store.writeResults(mine, { done: done(h, ['k:o0']) }, call),
    );
    await rejectsLost(store.releaseChunk(mine, { kind: 'completed' }));
    const state = await stepOf(store, run);
    assert.equal(state.counts.done, 0);
    // Spend is a fact about money, never about the claim: the lost call's cost lands on the run and its chunk.
    assert.deepEqual((await store.getRun(run.id)).spend, call);
    assert.deepEqual(
      (await store.chunks(run.id)).find((c) => c.index === mine.index)?.spend,
      call,
    );
    if (store.keepsValues)
      assert.equal(
        (await store.itemResults(SCOPE, h.tenants[0], ['k:o0'])).size,
        1,
      );
    // The holder renews, and its writes land.
    const kept = await store.renewClaim('b', [theirs], 1000);
    assert.deepEqual(kept.lost, []);
    await store.writeResults(theirs, { done: done(h, ['k:o1']) }, call);
    assert.equal((await stepOf(store, run)).counts.done, 1);
  });

  it('spend lands after a cancel; the counts and item marks stay as they were', async () => {
    const h = make();
    const { store } = h;
    const run = await running(h);
    await store.planItems(run.id, STEP, page(0, 3, null));
    const claim = one(await store.claimChunks('w', 1, 1000));
    await store.writeResults(claim, { done: done(h, ['k:o0']) }, call);
    assert.equal(await store.reserve(claim, 0.5), 'ok');
    await store.transition(run.id, { to: 'canceled' });
    // A cancel refuses every new call at once, and drops the chunk's reservations.
    assert.equal(await store.reserve(claim, 0.5), 'refused');
    assert.equal((await store.getRun(run.id)).reservedUsd, 0);
    // A call in flight when the run was canceled lands: its result and spend are kept, its marks are fenced.
    await rejectsLost(
      store.writeResults(claim, { done: done(h, ['k:o1']) }, call, {
        reservedUsd: 0.5,
      }),
    );
    const after = await store.getRun(run.id);
    assert.equal(after.status, 'canceled');
    assert.deepEqual(after.spend, {
      calls: 2,
      inputTokens: 200,
      costUsd: call.costUsd * 2,
    });
    assert.equal(after.reservedUsd, 0);
    const state = await stepOf(store, run);
    assert.equal(state.counts.done, 1);
    const items = await store.items(run.id, STEP);
    assert.deepEqual(
      items.map((i) => i.status),
      ['done', 'pending', 'pending'],
    );
    if (store.keepsValues)
      // Its late result stays in the cache: valid for its key, and paid for.
      assert.equal(
        (await store.itemResults(SCOPE, h.tenants[0], ['k:o1'])).size,
        1,
      );
  });

  it("addSpend records a failed call's spend, unfenced, on the run and its chunk", async () => {
    const h = make();
    const { store, clock } = h;
    const run = await running(h);
    await store.planItems(run.id, STEP, page(0, 3, null));
    const claim = one(await store.claimChunks('w', 1, 1000));
    await store.addSpend(claim, call);
    // After a lost claim and after a cancel too: spend never depends on the claim.
    clock.advance(2000);
    await store.sweepExpired();
    await store.addSpend(claim, call);
    await store.transition(run.id, { to: 'canceled' });
    await store.addSpend(claim, call);
    const after = await store.getRun(run.id);
    assert.equal(after.spend.calls, 3);
    assert.equal(after.spend.inputTokens, 300);
    assert.deepEqual(
      (await store.chunks(run.id)).find((c) => c.index === claim.index)?.spend
        .calls,
      3,
    );
    assert.equal((await stepOf(store, run)).counts.done, 0);
    await assert.rejects(
      store.addSpend(
        { ...claim, runId: '00000000-0000-4000-8000-000000000000' },
        call,
      ),
      RunNotFoundError,
    );
  });

  const childOf = (key: string, budget = { maxItems: 5 }) => ({
    key,
    jobKey: 'toy.child',
    jobVersion: 'v1',
    input: undefined,
    budget,
  });
  /** A parent running its children step `kids`, with children a and b started. */
  const parentWithChildren = async (
    h: StoreHarness,
    over: Partial<NewRun> = {},
  ) => {
    const parent = await createdRun(
      h.store,
      newRun(h, { dryRun: true, requestedBy: null, ...over }),
    );
    await h.store.transition(parent.id, { to: 'running', from: 'pending' });
    const { slots } = await h.store.startChildren(
      { runId: parent.id, step: 'kids', index: 1 },
      [childOf('a'), childOf('b')],
    );
    return { parent, slots };
  };
  const endChild = async (
    h: StoreHarness,
    runId: string,
    to: 'completed' | 'failed' | 'canceled',
  ) => {
    await h.store.transition(runId, { to: 'running', from: 'pending' });
    await h.store.transition(
      runId,
      to === 'failed'
        ? { to, error: { type: 'ToyFailed', message: 'it failed' } }
        : { to },
    );
  };

  it('startChildren: one slot and one child per key, for good, even when two advancers race; a child inherits from its parent', async () => {
    const h = make();
    const { store } = h;
    const parent = await createdRun(store, newRun(h, { dryRun: true }));
    await store.transition(parent.id, { to: 'running', from: 'pending' });
    const start = () =>
      store.startChildren({ runId: parent.id, step: 'kids', index: 1 }, [
        childOf('a'),
        childOf('b'),
      ]);
    const [one, two] = await Promise.all([start(), start()]);
    assert.equal(one.started.length + two.started.length, 2);
    const again = await start();
    assert.equal(again.started.length, 0);
    assert.deepEqual(
      again.slots.map((x) => [x.key, x.status, x.attempts]),
      [
        ['a', 'pending', 1],
        ['b', 'pending', 1],
      ],
    );
    const child = await store.getRun(again.slots[0]?.childRunId ?? '');
    assert.equal(child.tenantId, parent.tenantId);
    assert.equal(child.dryRun, true);
    assert.equal(child.trigger, parent.trigger);
    assert.equal(child.cache, parent.cache);
    assert.equal(child.status, 'pending');
    assert.equal(child.parentRunId, parent.id);
    assert.equal(child.parentStep, 'kids');
    assert.equal(child.childKey, 'a');
    assert.equal(child.depth, 1);
    assert.equal(child.dedupeKey, null);
    const step = (await store.stepStates(parent.id)).find(
      (x) => x.name === 'kids',
    );
    assert.equal(step?.kind, 'children');
    assert.equal(step?.counts.total, 2);
    // A child of a child of a child is as deep as runs go.
    let deepest = child;
    for (let depth = 2; depth <= 3; depth++) {
      await store.transition(deepest.id, { to: 'running', from: 'pending' });
      const { slots } = await store.startChildren(
        { runId: deepest.id, step: 'kids', index: 0 },
        [childOf('x')],
      );
      deepest = await store.getRun(slots[0]?.childRunId ?? '');
      assert.equal(deepest.depth, depth);
    }
    await assert.rejects(
      store.startChildren({ runId: deepest.id, step: 'kids', index: 0 }, [
        childOf('x'),
      ]),
      JobDefinitionError,
    );
  });

  it('a child ending settles its slot (done, failed, or Canceled) and pokes its parent’s waiting step; a child never moves its parent', async () => {
    const h = make();
    const { store } = h;
    const { parent, slots } = await parentWithChildren(h);
    await store.park(
      parent.id,
      { name: 'kids', index: 1, kind: 'children' },
      { kind: 'children', name: 'toy.child', wakeAt: null },
    );
    await endChild(h, slots[0]?.childRunId ?? '', 'completed');
    const poked = (await store.stepStates(parent.id)).find(
      (x) => x.name === 'kids',
    );
    assert.ok(poked?.wait?.wakeAt, 'the waiting step is due');
    assert.ok((await store.dueRunIds(h.clock.now(), 10)).includes(parent.id));
    await endChild(h, slots[1]?.childRunId ?? '', 'canceled');
    assert.equal((await store.getRun(parent.id)).status, 'waiting');
    const { slots: settled, ended } = await store.settleSlots(
      parent.id,
      'kids',
    );
    assert.deepEqual(
      settled.map((x) => [x.key, x.status, x.errorType]),
      [
        ['a', 'done', null],
        ['b', 'failed', 'Canceled'],
      ],
    );
    assert.equal(ended.length, 2);
    assert.equal((await store.settleSlots(parent.id, 'kids')).ended.length, 0);
    const counts = (await store.stepStates(parent.id)).find(
      (x) => x.name === 'kids',
    )?.counts;
    assert.equal(counts?.done, 1);
    assert.equal(counts?.failed, 1);
  });

  it('retry puts a new child in a failed slot (attempt 2) and skip settles one; both refuse a slot that is not failed', async () => {
    const h = make();
    const { store } = h;
    const { parent, slots } = await parentWithChildren(h);
    await endChild(h, slots[0]?.childRunId ?? '', 'failed');
    await store.settleSlots(parent.id, 'kids');
    assert.equal(
      await store.retryChild(parent.id, 'kids', 'b', childOf('b')),
      null,
    );
    assert.equal(await store.skipChild(parent.id, 'kids', 'b'), null);
    const retried = await store.retryChild(
      parent.id,
      'kids',
      'a',
      childOf('a'),
    );
    assert.equal(retried?.status, 'pending');
    assert.equal(retried?.attempts, 2);
    assert.notEqual(retried?.childRunId, slots[0]?.childRunId);
    await endChild(h, retried?.childRunId ?? '', 'failed');
    await store.settleSlots(parent.id, 'kids');
    await store.park(
      parent.id,
      { name: 'kids', index: 1, kind: 'children' },
      { kind: 'children', name: 'toy.child', wakeAt: null },
    );
    const skipped = await store.skipChild(parent.id, 'kids', 'a');
    assert.equal(skipped?.status, 'skipped');
    const step = (await store.stepStates(parent.id)).find(
      (x) => x.name === 'kids',
    );
    assert.ok(step?.wait?.wakeAt, 'a skip pokes the waiting step');
    assert.equal(step?.counts.skipped, 1);
    assert.equal(step?.counts.failed, 0);
  });

  it("a parent's cancel or failure cancels every open descendant at once; a pause cascades as `parent`, and its resume restores only those", async () => {
    const h = make();
    const { store } = h;
    const { parent, slots } = await parentWithChildren(h);
    const [a, b] = [slots[0]?.childRunId ?? '', slots[1]?.childRunId ?? ''];
    await store.transition(a, { to: 'running', from: 'pending' });
    const { slots: grand } = await store.startChildren(
      { runId: a, step: 'kids', index: 0 },
      [childOf('g')],
    );
    const g = grand[0]?.childRunId ?? '';
    // b pauses for its own budget first: the parent's resume must leave it.
    await store.transition(b, { to: 'paused', reason: 'budget' });
    const paused = await store.transition(parent.id, {
      to: 'paused',
      reason: 'operator',
    });
    assert.deepEqual(
      paused.cascaded.map((r) => [r.id, r.status, r.pauseReason]).sort(),
      [
        [a, 'paused', 'parent'],
        [g, 'paused', 'parent'],
      ].sort(),
    );
    const resumed = await store.transition(parent.id, {
      to: 'running',
      from: 'paused',
    });
    assert.deepEqual(resumed.cascaded.map((r) => r.id).sort(), [a, g].sort());
    assert.equal((await store.getRun(b)).pauseReason, 'budget');
    const canceled = await store.transition(parent.id, { to: 'canceled' });
    assert.deepEqual(
      canceled.cascaded.map((r) => r.id).sort(),
      [a, b, g].sort(),
    );
    for (const id of [a, b, g])
      assert.equal((await store.getRun(id)).status, 'canceled');
    // A failed parent cascades the same way.
    const second = await parentWithChildren(h);
    const failed = await store.transition(second.parent.id, {
      to: 'failed',
      error: { type: 'ToyFailed', message: 'x' },
    });
    assert.equal(failed.cascaded.length, 2);
  });

  it('treeSpend sums the run and every descendant, every attempt, once each', async () => {
    const h = make();
    const { store } = h;
    const { parent, slots } = await parentWithChildren(h);
    const spend = { calls: 2, inputTokens: 100, costUsd: 0.5 };
    for (const slot of slots) {
      const id = slot.childRunId;
      await store.transition(id, { to: 'running', from: 'pending' });
      await store.startStep(
        id,
        { name: STEP, index: 1, kind: 'map' },
        { attempts: 0 },
      );
      await store.planItems(id, STEP, page(0, 1, null));
      const [c] = await store.claimChunks('w', 1, 60_000, ['toy.child']);
      assert.ok(c);
      await store.addSpend(c, spend);
    }
    const total = await store.treeSpend(parent.id);
    assert.equal(total.calls, 4);
    assert.equal(total.inputTokens, 200);
    assert.ok(Math.abs(total.costUsd - 1) < 1e-9);
    assert.deepEqual(await store.treeSpend(slots[0]?.childRunId ?? ''), spend);
  });

  it('settleWait: the first signal wins, records its value and sender, and moves a waiting run back to running', async () => {
    const h = make();
    const { store } = h;
    const run = await running(h);
    const approval = { name: 'approval', index: 2, kind: 'wait' as const };
    const value = store.keepsValues ? { publish: ['v1'] } : undefined;
    const settle = (signal: string, by: string | null = h.user) =>
      store.settleWait(run.id, 'approval', { signal, output: value, by });
    // Not waiting yet: nothing to settle, and early signals are not buffered.
    assert.equal(await settle('approve'), false);
    assert.equal(
      await store.park(run.id, approval, {
        kind: 'signal',
        name: 'approve',
        wakeAt: null,
      }),
      true,
    );
    assert.equal((await store.getRun(run.id)).status, 'waiting');
    // Another signal's name is refused.
    assert.equal(await settle('reject'), false);
    assert.equal(await settle('approve'), true);
    const state = (await store.stepStates(run.id)).find(
      (s) => s.name === 'approval',
    );
    assert.equal(state?.status, 'completed');
    assert.equal(state?.settledBy, h.user);
    assert.equal(state?.kind, 'wait');
    assert.deepEqual(state?.wait, {
      kind: 'signal',
      name: 'approve',
      since: state?.wait?.since,
      wakeAt: null,
    });
    assert.deepEqual(await store.stepOutput(run.id, 'approval'), value);
    assert.equal((await store.getRun(run.id)).status, 'running');
    // The first signal wins: a second finds the step settled.
    assert.equal(await settle('approve', null), false);
    assert.equal(
      (await store.stepStates(run.id)).find((s) => s.name === 'approval')
        ?.settledBy,
      h.user,
    );
    // A gate's wait is no signal's.
    const gated = { name: 'gated', index: 3, kind: 'step' as const };
    await store.park(run.id, gated, {
      kind: 'gate',
      name: 'approve',
      wakeAt: null,
    });
    assert.equal(
      await store.settleWait(run.id, 'gated', {
        signal: 'approve',
        output: value,
        by: null,
      }),
      false,
    );
  });

  it('settleWait on a paused run records the signal and leaves the run paused for its resume', async () => {
    const h = make();
    const { store } = h;
    const run = await running(h);
    await store.park(
      run.id,
      { name: 'approval', index: 2, kind: 'wait' },
      { kind: 'signal', name: 'approve', wakeAt: null },
    );
    await store.transition(run.id, { to: 'paused', reason: 'operator' });
    assert.equal(
      await store.settleWait(run.id, 'approval', {
        signal: 'approve',
        output: store.keepsValues ? { ok: true } : undefined,
        by: null,
      }),
      true,
    );
    assert.equal((await store.getRun(run.id)).status, 'paused');
    const state = (await store.stepStates(run.id)).find(
      (s) => s.name === 'approval',
    );
    assert.equal(state?.status, 'completed');
    assert.equal(state?.settledBy, null);
  });

  it('park and unpark are CASes on the step and its run; a waiting run holds its dedupe key and is not open work', async () => {
    const h = make();
    const { store, clock } = h;
    const run = await running(h, { dedupeKey: 'parked' });
    const gated = { name: 'gated', index: 2, kind: 'step' as const };
    const since = clock.now();
    const firstWake = new Date(since.getTime() + 60_000);
    assert.equal(
      await store.park(run.id, gated, {
        kind: 'gate',
        name: 'ai-processing',
        wakeAt: firstWake,
      }),
      true,
    );
    const parked = (await store.stepStates(run.id)).find(
      (s) => s.name === 'gated',
    );
    assert.equal(parked?.status, 'waiting');
    // A step that parks before it ever ran spends no attempt.
    assert.equal(parked?.attempts, 0);
    assert.deepEqual(parked?.wait, {
      kind: 'gate',
      name: 'ai-processing',
      since,
      wakeAt: firstWake,
    });
    assert.equal((await store.getRun(run.id)).status, 'waiting');
    // Waiting is open: it holds the dedupe key. It is not open work: the sweep's open runs skip it.
    const again = await store.createRun(newRun(h, { dedupeKey: 'parked' }));
    assert.equal(again.created, false);
    assert.equal(again.run.id, run.id);
    assert.ok(!(await store.openRunIds(100)).includes(run.id));
    // Parking again on the same gate keeps when it started waiting.
    clock.advance(1_000);
    const secondWake = new Date(clock.now().getTime() + 120_000);
    assert.equal(
      await store.park(run.id, gated, {
        kind: 'gate',
        name: 'ai-processing',
        wakeAt: secondWake,
      }),
      true,
    );
    const reparked = (await store.stepStates(run.id)).find(
      (s) => s.name === 'gated',
    );
    assert.deepEqual(reparked?.wait, {
      kind: 'gate',
      name: 'ai-processing',
      since,
      wakeAt: secondWake,
    });
    // Unpark: the step and the run carry on; the wait's kind and name stay, its wake is cleared.
    assert.equal(await store.unpark(run.id, 'gated'), true);
    const woke = (await store.stepStates(run.id)).find(
      (s) => s.name === 'gated',
    );
    assert.equal(woke?.status, 'running');
    assert.deepEqual(woke?.wait, {
      kind: 'gate',
      name: 'ai-processing',
      since,
      wakeAt: null,
    });
    assert.equal((await store.getRun(run.id)).status, 'running');
    assert.equal(await store.unpark(run.id, 'gated'), false);
    // A settled step never parks; a paused or ended run parks nothing.
    await store.recordStep(run.id, 'gated', { status: 'completed' });
    assert.equal(
      await store.park(run.id, gated, {
        kind: 'gate',
        name: 'ai-processing',
        wakeAt: null,
      }),
      false,
    );
    await store.transition(run.id, { to: 'paused', reason: 'operator' });
    assert.equal(
      await store.park(
        run.id,
        { name: STEP, index: 1, kind: 'map' },
        { kind: 'gate', name: 'ai-processing', wakeAt: null },
      ),
      false,
    );
    assert.equal((await store.getRun(run.id)).status, 'paused');
    await store.transition(run.id, { to: 'canceled' });
    assert.equal(
      await store.park(
        run.id,
        { name: STEP, index: 1, kind: 'map' },
        { kind: 'gate', name: 'ai-processing', wakeAt: null },
      ),
      false,
    );
  });

  it('a waiting run can be paused, resumed and canceled', async () => {
    const h = make();
    const { store } = h;
    const run = await running(h);
    await store.park(
      run.id,
      { name: STEP, index: 1, kind: 'map' },
      { kind: 'gate', name: 'ai-processing', wakeAt: null },
    );
    assert.equal(
      (await store.transition(run.id, { to: 'paused', reason: 'operator' }))
        .changed,
      true,
    );
    // A resume goes to running; the next advance finds its step waiting and parks it again.
    assert.equal(
      (await store.transition(run.id, { to: 'running', from: 'paused' }))
        .changed,
      true,
    );
    assert.equal((await stepOf(store, run)).status, 'waiting');
    await store.park(
      run.id,
      { name: STEP, index: 1, kind: 'map' },
      { kind: 'gate', name: 'ai-processing', wakeAt: null },
    );
    assert.equal((await store.getRun(run.id)).status, 'waiting');
    assert.equal(
      (await store.transition(run.id, { to: 'canceled' })).changed,
      true,
    );
  });

  it('dueRunIds returns a waiting run once its wait is due, oldest first, keyset paged', async () => {
    const h = make();
    const { store, clock } = h;
    const start = clock.now().getTime();
    const park = async (wakeInMs: number | null) => {
      const run = await running(h);
      await store.park(
        run.id,
        { name: STEP, index: 1, kind: 'map' },
        {
          kind: 'gate',
          name: 'ai-processing',
          wakeAt: wakeInMs === null ? null : new Date(start + wakeInMs),
        },
      );
      clock.advance(1);
      return run.id;
    };
    const first = await park(60_000);
    const second = await park(120_000);
    const never = await park(null);
    assert.deepEqual(await store.dueRunIds(new Date(start), 10), []);
    assert.deepEqual(await store.dueRunIds(new Date(start + 60_000), 10), [
      first,
    ]);
    const late = new Date(start + 3_600_000);
    assert.deepEqual(await store.dueRunIds(late, 10), [first, second]);
    assert.deepEqual(await store.dueRunIds(late, 1), [first]);
    assert.deepEqual(await store.dueRunIds(late, 10, first), [second]);
    // A wait with no wake is left to its event; a woken step is not due.
    assert.ok(!(await store.dueRunIds(late, 10)).includes(never));
    await store.unpark(first, STEP);
    assert.deepEqual(await store.dueRunIds(late, 10), [second]);
  });

  it("wakeGate wakes only that tenant's steps waiting on that gate", async () => {
    const h = make();
    const { store, clock } = h;
    const hourOn = new Date(clock.now().getTime() + 3_600_000);
    const park = async (tenantId: string, gateName: string) => {
      const run = await running(h, { tenantId });
      await store.park(
        run.id,
        { name: STEP, index: 1, kind: 'map' },
        { kind: 'gate', name: gateName, wakeAt: hourOn },
      );
      return run.id;
    };
    const mine = await park(h.tenants[0], 'ai-processing');
    await park(h.tenants[1], 'ai-processing');
    await park(h.tenants[0], 'backfill-done');
    assert.deepEqual(
      await store.wakeGate(h.tenants[0], 'ai-processing'),
      [mine],
    );
    assert.deepEqual(await store.dueRunIds(clock.now(), 10), [mine]);
    assert.deepEqual(await store.wakeGate(h.tenants[0], 'nothing'), []);
  });

  it('rule 3: counts and spend move with the items they describe, once per item', async () => {
    const h = make();
    const { store } = h;
    const run = await running(h);
    await store.planItems(run.id, STEP, page(0, 4, null));
    const claim = one(await store.claimChunks('w', 1, 1000));
    await store.writeResults(
      claim,
      {
        done: done(h, ['k:o0']),
        cached: ['k:o1'],
        failed: [{ key: 'k:o2', errorType: 'Error' }],
      },
      call,
    );
    await store.writeResults(claim, { done: done(h, ['k:o0']) }, call);
    let state = await stepOf(store, run);
    assert.deepEqual(state.counts, {
      total: 4,
      done: 1,
      cached: 1,
      failed: 1,
      skipped: 0,
    });
    assert.equal((await store.getRun(run.id)).spend.calls, 2);
    assert.deepEqual(
      (await store.pendingItems(claim)).map((i) => i.key),
      ['k:o3'],
    );
    await store.releaseChunk(claim, {
      kind: 'failed',
      error: { type: 'X', message: 'x' },
    });
    state = await stepOf(store, run);
    // A failed chunk fails its unsettled items; the run itself is the engine's to finish.
    assert.equal(state.counts.failed, 2);
    assert.equal(state.chunks.failed, 1);
    assert.equal((await store.getRun(run.id)).status, 'running');
    const items = await store.items(run.id, STEP);
    assert.deepEqual(
      items.map((i) => [i.key, i.status, i.errorType]),
      [
        ['k:o0', 'done', null],
        ['k:o1', 'cached', null],
        ['k:o2', 'failed', 'Error'],
        ['k:o3', 'failed', 'X'],
      ],
    );
  });

  it('a retry waits out its backoff; a yield gives the chunk back without spending an attempt', async () => {
    const h = make();
    const { store, clock } = h;
    const run = await running(h);
    await store.planItems(run.id, STEP, page(0, 2, null));
    const first = one(await store.claimChunks('w', 1, 1000));
    await store.releaseChunk(first, {
      kind: 'retry',
      at: new Date(clock.now().getTime() + 500),
      error: { type: 'E', message: 'e' },
    });
    assert.deepEqual(await store.claimChunks('w', 1, 1000), []);
    clock.advance(500);
    const second = one(await store.claimChunks('w', 1, 1000));
    assert.equal(second.attempts, 2);
    await store.releaseChunk(second, { kind: 'yield' });
    assert.equal(one(await store.claimChunks('w', 1, 1000)).attempts, 2);
  });

  it('a spent budget refuses the reservation and pauses the run; resume and cancel move it on', async () => {
    const h = make();
    const { store } = h;
    const run = await running(h, {
      budget: { maxItems: 10, maxUsd: 0.001 },
    });
    await store.planItems(run.id, STEP, page(0, 4, null));
    const claim = one(await store.claimChunks('w', 1, 1000));
    assert.equal(await store.reserve(claim, 0.0006), 'ok');
    assert.equal(await store.reserve(claim, 0.0006), 'paused');
    assert.equal(await store.reserve(claim, 0.0006), 'refused');
    const paused = await store.getRun(run.id);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pauseReason, 'budget');
    assert.deepEqual(await store.claimChunks('w', 1, 1000), []);
    const resumed = await store.transition(run.id, {
      to: 'running',
      from: 'paused',
      budget: { maxItems: 10, maxUsd: 1 },
    });
    assert.equal(resumed.run.budget.maxUsd, 1);
    assert.equal(await store.reserve(claim, 0.0006), 'ok');
    await store.transition(run.id, { to: 'canceled' });
    const p = await store.progress(run.id);
    assert.equal(p.run.status, 'canceled');
    assert.equal(p.chunks.canceled, 1);
    assert.equal(p.run.reservedUsd, 0, 'a canceled chunk holds no reservation');
    await rejectsLost(
      store.writeResults(claim, { done: done(h, ['k:o0']) }, zero),
    );
  });

  it('maxCalls counts calls reserved and spent; a passed deadline pauses at the next reservation', async () => {
    const h = make();
    const { store, clock } = h;
    const run = await running(h, {
      budget: {
        maxItems: 10,
        maxCalls: 2,
        deadline: new Date(clock.now().getTime() + 1000),
      },
    });
    await store.planItems(run.id, STEP, page(0, 1, null));
    const claim = one(await store.claimChunks('w', 1, 1000));
    assert.equal(await store.reserve(claim, 0), 'ok');
    assert.equal(await store.reserve(claim, 0), 'ok');
    assert.equal(await store.reserve(claim, 0), 'paused');
    await store.transition(run.id, {
      to: 'running',
      from: 'paused',
      budget: {
        maxItems: 10,
        deadline: new Date(clock.now().getTime() + 1000),
      },
    });
    clock.advance(1000);
    assert.equal(await store.reserve(claim, 0), 'paused');
    assert.equal((await store.getRun(run.id)).pauseReason, 'deadline');
  });

  it("a run's pending chunks, due first, at most a limit", async () => {
    const h = make();
    const { store, clock } = h;
    const run = await running(h, { chunkSize: 2 });
    await store.planItems(run.id, STEP, page(0, 8, null));
    const first = one(await store.claimChunks('w', 1, 1000));
    clock.advance(10);
    await store.releaseChunk(first, {
      kind: 'retry',
      at: new Date(clock.now().getTime() + 5_000),
      error: { type: 'Toy', message: 'toy' },
    });
    const second = one(await store.claimChunks('w', 1, 1000));
    await store.releaseChunk(second, { kind: 'completed' });
    const pending = await store.pendingChunks(run.id, 10);
    // Chunk 1 completed; chunk 0 retries later, so the due ones (2, 3) come first.
    assert.deepEqual(
      pending.map((c) => c.index),
      [2, 3, 0],
    );
    assert.deepEqual(
      (await store.pendingChunks(run.id, 1)).map((c) => c.index),
      [2],
    );
  });

  it("a step's items read by range: from an ordinal, at most a limit, in order", async () => {
    const h = make();
    const { store } = h;
    const run = await running(h, { chunkSize: 2 });
    await store.planItems(run.id, STEP, page(0, 6, null));
    const keys = async (range?: { from?: number; limit?: number }) =>
      (await store.items(run.id, STEP, range)).map((i) => i.key);
    assert.deepEqual(await keys({ from: 2, limit: 3 }), [
      'k:o2',
      'k:o3',
      'k:o4',
    ]);
    assert.deepEqual(await keys({ from: 4 }), ['k:o4', 'k:o5']);
    assert.deepEqual(await keys({ from: 6, limit: 2 }), []);
    assert.equal((await keys()).length, 6);
  });

  it('an early stop ends planning: the step is planned, and a page planned after it adds nothing', async () => {
    const h = make();
    const { store } = h;
    const run = await running(h, { chunkSize: 2 });
    await store.planItems(run.id, STEP, page(0, 4, 'more'));
    await store.stopStep(run.id, STEP, 2);
    assert.equal((await stepOf(store, run)).planned, true);
    await store.planItems(run.id, STEP, page(4, 8, null));
    const state = await stepOf(store, run);
    assert.equal(state.counts.total, 4);
    assert.equal(state.chunks.pending + state.chunks.running, 0);
  });

  it("an early stop skips the step's items from `used` on and cancels its open chunks", async () => {
    const h = make();
    const { store } = h;
    const run = await running(h, { chunkSize: 2 });
    await store.planItems(run.id, STEP, page(0, 6, null));
    const claim = one(await store.claimChunks('w', 1, 1000));
    await store.writeResults(claim, { done: done(h, ['k:o0', 'k:o1']) }, call);
    await store.releaseChunk(claim, { kind: 'completed' });
    const inFlight = one(await store.claimChunks('w', 1, 1000));
    await store.stopStep(run.id, STEP, 3);
    const state = await stepOf(store, run);
    assert.equal(state.counts.skipped, 3);
    assert.equal(state.chunks.canceled, 2);
    assert.equal(state.chunks.pending + state.chunks.running, 0);
    assert.deepEqual(
      (await store.items(run.id, STEP)).map((i) => i.status),
      ['done', 'done', 'pending', 'skipped', 'skipped', 'skipped'],
    );
    await rejectsLost(
      store.writeResults(inFlight, { done: done(h, ['k:o2']) }, call),
    );
    await store.recordStep(run.id, STEP, {
      status: 'completed',
      speculation: { speculated: 3, used: 3, overshoot: 0 },
    });
    assert.deepEqual((await stepOf(store, run)).speculation, {
      speculated: 3,
      used: 3,
      overshoot: 0,
    });
  });

  it('a named chunk is claimed only while it is pending, eligible and its run running; never another one', async () => {
    const h = make();
    const { store, clock } = h;
    const run = await running(h, { chunkSize: 2 });
    await store.planItems(run.id, STEP, page(0, 4, null));
    const ref = { runId: run.id, step: STEP, index: 1 };
    const claim = await store.claimChunk('w', 1000, ref);
    assert.ok(claim);
    assert.deepEqual([claim.index, claim.attempts, claim.owner], [1, 1, 'w']);
    assert.equal(await store.claimChunk('w', 1000, ref), null, 'running');
    await store.releaseChunk(claim, {
      kind: 'retry',
      at: new Date(clock.now().getTime() + 500),
      error: { type: 'E', message: 'e' },
    });
    assert.equal(
      await store.claimChunk('w', 1000, ref),
      null,
      'not yet eligible',
    );
    clock.advance(500);
    await store.transition(run.id, { to: 'paused', reason: 'operator' });
    assert.equal(await store.claimChunk('w', 1000, ref), null, 'run paused');
    await store.transition(run.id, { to: 'running', from: 'paused' });
    assert.equal((await store.claimChunk('w', 1000, ref))?.attempts, 2);
    assert.equal(
      await store.claimChunk('w', 1000, { ...ref, index: 9 }),
      null,
      'no such chunk',
    );
    // Unnamed: the next eligible chunk.
    assert.equal((await store.claimChunk('w', 1000))?.index, 0);
    assert.equal(await store.claimChunk('w', 1000), null);
  });

  it("a run's chunks list by step, then index; open runs list pending and running, oldest first", async () => {
    const h = make();
    const { store, clock } = h;
    const run = await createdRun(store, newRun(h, { chunkSize: 2 }));
    await store.transition(run.id, { to: 'running', from: 'pending' });
    await store.startStep(
      run.id,
      { name: 'later', index: 2, kind: 'map' },
      { attempts: 0 },
    );
    await store.startStep(
      run.id,
      { name: STEP, index: 1, kind: 'map' },
      { attempts: 0 },
    );
    await store.planItems(run.id, 'later', page(0, 2, null));
    await store.planItems(run.id, STEP, page(0, 3, null));
    assert.deepEqual(
      (await store.chunks(run.id)).map((c) => [c.step, c.index, c.status]),
      [
        [STEP, 0, 'pending'],
        [STEP, 1, 'pending'],
        ['later', 0, 'pending'],
      ],
    );
    clock.advance(1);
    const pending = await createdRun(store, newRun(h));
    clock.advance(1);
    const paused = await createdRun(store, newRun(h));
    await store.transition(paused.id, { to: 'paused', reason: 'operator' });
    clock.advance(1);
    const finished = await createdRun(store, newRun(h));
    await store.transition(finished.id, { to: 'canceled' });
    const open = await store.openRunIds(10);
    assert.deepEqual(
      open.filter((id) =>
        [run.id, pending.id, paused.id, finished.id].includes(id),
      ),
      [run.id, pending.id],
    );
    assert.equal((await store.openRunIds(1)).length, 1);
    // `after` continues in the same order, so a sweep can rotate past a full page.
    const mine = (ids: string[]) =>
      ids.filter((id) =>
        [run.id, pending.id, paused.id, finished.id].includes(id),
      );
    assert.deepEqual(mine(await store.openRunIds(10, run.id)), [pending.id]);
    assert.deepEqual(mine(await store.openRunIds(10, pending.id)), []);
    assert.deepEqual(
      await store.openRunIds(10, '00000000-0000-4000-8000-0000000000ff'),
      [],
    );
  });

  it('a job whose values live in recorders runs, resumes after a crash and reads its cache the same on this store', async () => {
    const h = make();
    const { store, clock } = h;
    const limiters = localLimiters({ toy: { inFlight: 1 } });
    const executor = { pollMs: 1, chunkConcurrency: 1 };
    let crashAt = 3;
    const atCrash = Promise.withResolvers<void>();
    const toy = toyScoring({
      recorded: true,
      onCall: (n, _call, signal) => {
        if (n !== crashAt) return undefined;
        atCrash.resolve();
        return hang(signal);
      },
    });
    const request = {
      ...toyRequest(h, 9, toy.job.key),
      dedupeKey: 'recorded',
      chunkSize: 4,
    };
    const crash = new AbortController();
    const dying = runToCompletion(toy.job, request, {
      store,
      clock,
      limiters,
      signal: crash.signal,
      executor,
    });
    await Promise.race([atCrash.promise, dying]);
    crash.abort(new Error('the process died'));
    await assert.rejects(dying);
    const asked = toy.calls.slice(0, crashAt - 1).flatMap((c) => c.refs);
    crashAt = 0;
    clock.advance(10 * 60_000);
    const before = toy.calls.length;
    const resumed = await runToCompletion(toy.job, request, {
      store,
      clock,
      limiters,
      executor,
    });
    const expected = {
      count: 9,
      failed: 0,
      total: Math.round(ids(9).reduce((a, r) => a + scoreOf(r), 0) * 100),
    };
    assert.equal(resumed.run.status, 'completed');
    assert.deepEqual(resumed.output, expected);
    const after = toy.calls.slice(before).flatMap((c) => c.refs);
    assert.deepEqual(
      after.filter((r) => asked.includes(r)),
      [],
      'no recorded item asked again',
    );
    assert.equal(toy.recorders?.score.saved.size, 9);
    // A later run of the same meaning reads the recorder's results instead of asking again.
    const calls = toy.calls.length;
    const again = await runToCompletion(
      toy.job,
      { ...request, dedupeKey: 'recorded-again' },
      { store, clock, limiters, executor },
    );
    assert.deepEqual(again.output, expected);
    assert.equal(toy.calls.length, calls);
    assert.equal(again.steps.find((s) => s.name === 'score')?.counts.cached, 9);
  });

  it('rule 2, one owner: a chunk swept and re-claimed by the same owner fences out the stale claim by its token', async () => {
    const h = make();
    const { store, clock } = h;
    const run = await running(h);
    await store.planItems(run.id, STEP, page(0, 3, null));
    const stale = one(await store.claimChunks('w', 1, 1000));
    clock.advance(2000);
    assert.equal(await store.sweepExpired(), 1);
    const fresh = one(await store.claimChunks('w', 1, 1000));
    assert.equal(fresh.owner, stale.owner);
    assert.notEqual(fresh.token, stale.token);
    const renewed = await store.renewClaim('w', [stale, fresh], 1000);
    assert.deepEqual(
      renewed.lost.map((c) => c.token),
      [stale.token],
    );
    await rejectsLost(
      store.writeResults(stale, { done: done(h, ['k:o0']) }, call),
    );
    await rejectsLost(store.releaseChunk(stale, { kind: 'completed' }));
    assert.equal((await stepOf(store, run)).chunks.running, 1);
    await store.writeResults(fresh, { done: done(h, ['k:o0']) }, call);
    await store.releaseChunk(fresh, {
      kind: 'failed',
      error: { type: 'X', message: 'x' },
    });
    assert.equal((await stepOf(store, run)).counts.done, 1);
  });

  it('a reservation is settled by its estimate: a write releases it whatever the call cost, a failed call returns it, a settle or a sweep drops what is left', async () => {
    const h = make();
    const { store, clock } = h;
    const run = await running(h, {
      budget: { maxItems: 10, maxUsd: 1.5, maxCalls: 3 },
    });
    await store.planItems(run.id, STEP, page(0, 2, null));
    const claim = one(await store.claimChunks('w', 1, 1000));
    assert.equal(await store.reserve(claim, 1), 'ok');
    await store.writeResults(
      claim,
      { done: done(h, ['k:o0']) },
      { calls: 1, inputTokens: 1, costUsd: 0.1 },
      { reservedUsd: 1 },
    );
    let back = await store.getRun(run.id);
    assert.equal(back.reservedUsd, 0);
    assert.equal(back.spend.costUsd, 0.1);
    // A failed call gives its reservation back, its call too: two more calls still fit under maxCalls 3.
    assert.equal(await store.reserve(claim, 1), 'ok');
    await store.releaseReservation(claim, 1);
    assert.equal((await store.getRun(run.id)).reservedUsd, 0);
    assert.equal(await store.reserve(claim, 0.5), 'ok');
    assert.equal(await store.reserve(claim, 0.5), 'ok');
    back = await store.getRun(run.id);
    assert.equal(back.reservedUsd, 1);
    // The chunk settles with both still out: they are dropped with it.
    await store.releaseChunk(claim, {
      kind: 'retry',
      at: clock.now(),
      error: { type: 'E', message: 'e' },
    });
    assert.equal((await store.getRun(run.id)).reservedUsd, 0);
    const again = one(await store.claimChunks('w', 1, 1000));
    assert.equal(await store.reserve(again, 0.4), 'ok');
    clock.advance(2000);
    assert.equal(await store.sweepExpired(), 1);
    assert.equal((await store.getRun(run.id)).reservedUsd, 0);
  });

  it('a stale claim reserves nothing and returns nothing: the fresh claim of its chunk keeps its own reservation', async () => {
    const h = make();
    const { store, clock } = h;
    const run = await running(h, { budget: { maxItems: 10, maxCalls: 2 } });
    await store.planItems(run.id, STEP, page(0, 2, null));
    const stale = one(await store.claimChunks('w', 1, 1000));
    assert.equal(await store.reserve(stale, 0.25), 'ok');
    clock.advance(2000);
    assert.equal(await store.sweepExpired(), 1);
    assert.equal((await store.getRun(run.id)).reservedUsd, 0, 'swept');
    const fresh = one(await store.claimChunks('w', 1, 1000));
    assert.equal(await store.reserve(fresh, 0.5), 'ok');
    // The stale claim's return must not take back the fresh claim's reservation, nor its call.
    await store.releaseReservation(stale, 0.5);
    assert.equal((await store.getRun(run.id)).reservedUsd, 0.5);
    assert.equal(await store.reserve(stale, 0.5), 'refused');
    assert.equal((await store.getRun(run.id)).reservedUsd, 0.5);
    // Its one call is still held: with maxCalls 2, one more fits and the next pauses.
    assert.equal(await store.reserve(fresh, 0), 'ok');
    assert.equal(await store.reserve(fresh, 0), 'paused');
  });

  it('a start comes only from pending and a resume only from paused', async () => {
    const h = make();
    const { store } = h;
    const run = await createdRun(store, newRun(h));
    assert.equal(
      (await store.transition(run.id, { to: 'running', from: 'paused' }))
        .changed,
      false,
    );
    await store.transition(run.id, { to: 'paused', reason: 'operator' });
    // A pause that landed before the start: the start is refused, never undoing it.
    assert.equal(
      (await store.transition(run.id, { to: 'running', from: 'pending' }))
        .changed,
      false,
    );
    assert.equal((await store.getRun(run.id)).status, 'paused');
    assert.equal(
      (await store.transition(run.id, { to: 'running', from: 'paused' }))
        .changed,
      true,
    );
  });

  it('runs list in pages: at most `limit`, continued from the last one by its time and id', async () => {
    const h = make();
    const { store, clock } = h;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await createdRun(store, newRun(h))).id);
      // Two runs share a time: the id breaks the tie.
      if (i % 2 === 1) clock.advance(1);
    }
    const seen: string[] = [];
    let before: { createdAt: Date; id: string } | undefined;
    for (;;) {
      const page = await store.listRuns({
        tenantId: h.tenants[0],
        limit: 2,
        before,
      });
      assert.ok(page.length <= 2);
      if (!page.length) break;
      seen.push(...page.map((r) => r.id));
      const last = page[page.length - 1] as Run;
      before = { createdAt: last.createdAt, id: last.id };
    }
    assert.equal(seen.length, 5);
    assert.deepEqual([...seen].sort(), [...ids].sort());
  });

  it('one key for two different items is refused when planned; the same item twice is planned once', async () => {
    const h = make();
    const { store } = h;
    const run = await running(h);
    await assert.rejects(
      store.planItems(run.id, STEP, {
        refs: ['a', 'b'],
        keys: ['k:same', 'k:same'],
        next: null,
      }),
      (err) => err instanceof JobDefinitionError,
    );
    await store.planItems(run.id, STEP, {
      refs: ['a', 'a'],
      keys: ['k:a', 'k:a'],
      next: '2',
    });
    await assert.rejects(
      store.planItems(run.id, STEP, { refs: ['c'], keys: ['k:a'], next: null }),
      (err) => err instanceof JobDefinitionError,
    );
    assert.equal((await stepOf(store, run)).counts.total, 1);
  });


  // ── the advance lease (optional: `runLeases`) ───────────────────────────────
  it('a run lease is one owner\'s until it expires; its owner may take it again; an expired one is anyone\'s', async () => {
    const h = make();
    const leases = h.store.runLeases;
    if (!leases) return;
    const { run } = await h.store.createRun(newRun(h));
    const a = await leases.leaseRun(run.id, 'a', 1_000);
    assert.ok(a);
    assert.equal(await leases.leaseRun(run.id, 'b', 1_000), null);
    const again = await leases.leaseRun(run.id, 'a', 1_000);
    assert.ok(again);
    assert.notEqual(again.token, a.token);
    h.clock.advance(1_001);
    const b = await leases.leaseRun(run.id, 'b', 1_000);
    assert.ok(b);
    assert.equal(b.owner, 'b');
    assert.equal(await leases.leaseRun('00000000-0000-4000-8000-000000000000', 'a', 1_000), null);
  });

  it('a renewal keeps a lease its owner still holds; one expired and taken is lost', async () => {
    const h = make();
    const leases = h.store.runLeases;
    if (!leases) return;
    const { run } = await h.store.createRun(newRun(h));
    const a = await leases.leaseRun(run.id, 'a', 1_000);
    assert.ok(a);
    h.clock.advance(900);
    assert.deepEqual((await leases.renewRunLeases([a], 1_000)).lost, []);
    h.clock.advance(900);
    // Renewed at 900 for 1 s: still a's at 1,800, so b can't take it.
    assert.equal(await leases.leaseRun(run.id, 'b', 1_000), null);
    h.clock.advance(1_200);
    const b = await leases.leaseRun(run.id, 'b', 1_000);
    assert.ok(b);
    const { lost } = await leases.renewRunLeases([a], 1_000);
    assert.deepEqual(lost.map((l) => l.token), [a.token]);
  });

  it('a release frees the lease; a stale token releases nothing', async () => {
    const h = make();
    const leases = h.store.runLeases;
    if (!leases) return;
    const { run } = await h.store.createRun(newRun(h));
    const first = await leases.leaseRun(run.id, 'a', 1_000);
    assert.ok(first);
    const second = await leases.leaseRun(run.id, 'a', 1_000);
    assert.ok(second);
    await leases.releaseRunLease(first);
    assert.equal(await leases.leaseRun(run.id, 'b', 1_000), null);
    await leases.releaseRunLease(second);
    assert.ok(await leases.leaseRun(run.id, 'b', 1_000));
  });


  // ── collisions and the dedupe window (JOBS-3, codegen-targets d36) ────────────
  it("collision 'queue': a start finding an open run on its key is queued behind it, and the oldest queued one is pending once it ends", async () => {
    const h = make();
    const { store } = h;
    const { run: first } = await store.createRun(newRun(h, { dedupeKey: 'q' }));
    h.clock.advance(1);
    const second = await store.createRun(newRun(h, { dedupeKey: 'q', collision: 'queue' }));
    // Oldest first is by creation time: runs made in one millisecond are in no promised order.
    h.clock.advance(1);
    const third = await store.createRun(newRun(h, { dedupeKey: 'q', collision: 'queue' }));
    assert.equal(second.created, true);
    assert.equal(second.run.status, 'queued');
    assert.equal(third.run.status, 'queued');
    // A queued run is not open: the sweep never sees it, and a join still answers the open run.
    assert.deepEqual(await store.openRunIds(10), [first.id]);
    const joined = await store.createRun(newRun(h, { dedupeKey: 'q' }));
    assert.equal(joined.created, false);
    assert.equal(joined.run.id, first.id);
    await store.transition(first.id, { to: 'canceled' });
    assert.equal((await store.getRun(second.run.id)).status, 'pending');
    assert.equal((await store.getRun(third.run.id)).status, 'queued');
    await store.transition(second.run.id, { to: 'running', from: 'pending' });
    await store.transition(second.run.id, { to: 'completed' });
    assert.equal((await store.getRun(third.run.id)).status, 'pending');
  });

  it("collision 'queue' with nothing open is a plain start; a queued run can be canceled before it starts", async () => {
    const h = make();
    const { store } = h;
    const alone = await store.createRun(newRun(h, { dedupeKey: 'q2', collision: 'queue' }));
    assert.equal(alone.run.status, 'pending');
    const behind = await store.createRun(newRun(h, { dedupeKey: 'q2', collision: 'queue' }));
    assert.equal(behind.run.status, 'queued');
    const { changed } = await store.transition(behind.run.id, { to: 'canceled' });
    assert.equal(changed, true);
    await store.transition(alone.run.id, { to: 'canceled' });
    assert.equal((await store.getRun(behind.run.id)).status, 'canceled');
  });

  it('a dedupe window: a start within it after a run on the key ended returns that run; after it, a new one', async () => {
    const h = make();
    const { store } = h;
    const { run } = await store.createRun(newRun(h, { dedupeKey: 'w' }));
    await store.transition(run.id, { to: 'canceled' });
    h.clock.advance(500);
    const within = await store.createRun(newRun(h, { dedupeKey: 'w', dedupeWindowMs: 1_000 }));
    assert.equal(within.created, false);
    assert.equal(within.run.id, run.id);
    // Without a window, a finished run never answers a start.
    const none = await store.createRun(newRun(h, { dedupeKey: 'w2' }));
    await store.transition(none.run.id, { to: 'canceled' });
    assert.equal((await store.createRun(newRun(h, { dedupeKey: 'w2' }))).created, true);
    h.clock.advance(600);
    const after = await store.createRun(newRun(h, { dedupeKey: 'w', dedupeWindowMs: 1_000 }));
    assert.equal(after.created, true);
    // Another tenant's run on the same key is never in the window.
    await store.transition(after.run.id, { to: 'canceled' });
    const other = await store.createRun(
      newRun(h, { dedupeKey: 'w', dedupeWindowMs: 1_000, tenantId: h.tenants[1] }),
    );
    assert.equal(other.created, true);
  });

  return cases;
}
