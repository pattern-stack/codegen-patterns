import { describe, expect, it, jest } from 'bun:test';
import {
  RUN_WAIT_MAX_MS,
  type StartRunRequestValue,
  startRunRequestShape,
} from '../../shapes/index.ts';
import { createRegistry, runToCompletion } from '../../index.ts';
import type { Clock, Executor } from '../../ports.ts';
import {
  fakeClock,
  MemoryJobStore,
  memoryRecorder,
  recordingSink,
  TOY_LIMITS,
  toyInternal,
  toyPublicDry,
  toyPublicPublishing,
  toyPublicReadOnly,
} from '../../testing.ts';
import type { JobSystemActor, TenantJobActor } from '../job-actor.ts';
import { JobInputRefRegistry } from '../job-input-refs.ts';
import {
  JobAuthorityError,
  JobBudgetOverLimitError,
  JobCursorStaleError,
  JobInputInvalidError,
  JobInputRefusedError,
  JobNotFoundError,
  JobRunEndedError,
  JobRunNotFoundError,
  JobRunVersionConflictError,
  TooManyRunWaitsError,
} from '../jobs.errors.ts';
import {
  JobsService,
  MAX_RUN_WAITS_PER_TENANT,
  RUN_WAIT_POLL_MS,
} from '../jobs.service.ts';
import { publicJobCatalogOf } from '../public-job-catalog.ts';
import { readsOf } from './service-fixture.ts';

/** The memory store, declared durable, so a job with a side-effect step may run on it (as on Postgres). */
class DurableMemoryJobStore extends MemoryJobStore {
  override readonly durability = 'durable' as const;
}

type ToyOutput = { seenKey: string; scoredItems: number };

/** The toy job's output recorder, whose reads a test can make fail or drift from the output schema. */
function controllableOutputRecorder() {
  const inner = memoryRecorder<ToyOutput>();
  const state = { load: 'ok' as 'ok' | 'throw' | 'drift' };
  return {
    state,
    recorder: {
      save: (runId: string, value: ToyOutput) => inner.save(runId, value),
      async load(runId: string): Promise<ToyOutput | undefined> {
        if (state.load === 'throw') throw new Error('recorder read failed');
        if (state.load === 'drift')
          return { seenKey: 7, scoredItems: 'many' } as unknown as ToyOutput;
        return inner.load(runId);
      },
    },
  };
}

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const MEMBER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';

const tenantKey = (tenantId = TENANT_A): TenantJobActor => ({
  kind: 'apiKey',
  tenantId,
});
const member: TenantJobActor = {
  kind: 'member',
  tenantId: TENANT_A,
  userId: MEMBER_ID,
};
const admin: TenantJobActor = {
  kind: 'admin',
  tenantId: TENANT_A,
  userId: ADMIN_ID,
};
const system: JobSystemActor = {
  kind: 'system',
  tenantId: TENANT_A,
  userId: ADMIN_ID,
};

/** A start body as the wire sends it (snake_case), through the shape's defaults and conversion. */
const body = (wire: Record<string, unknown> = {}): StartRunRequestValue =>
  startRunRequestShape.fromPublic(
    startRunRequestShape.public.parse({
      input: { type_key: 'calls', item_count: 3 },
      ...wire,
    }),
  );

/** A clock whose sleeps can be held open, counted and hooked; time still moves as the fake clock's. */
function testClock() {
  const base = fakeClock();
  let hold = false;
  const waiting: (() => void)[] = [];
  const state = {
    sleeps: 0,
    onSleep: undefined as (() => Promise<void>) | undefined,
  };
  const clock: Clock = {
    now: () => base.now(),
    async sleep(ms, signal) {
      state.sleeps += 1;
      await state.onSleep?.();
      if (hold)
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason);
          waiting.push(resolve);
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      return base.sleep(ms, signal);
    },
  };
  return {
    clock,
    base,
    state,
    holdSleeps: () => {
      hold = true;
    },
    releaseSleeps: () => {
      hold = false;
      for (const w of waiting.splice(0)) w();
    },
  };
}

function setup(options: { submitFails?: boolean } = {}) {
  const output = controllableOutputRecorder();
  const dry = toyPublicDry({ summaryRecorder: output.recorder });
  const readOnly = toyPublicReadOnly();
  const internal = toyInternal();
  const publishing = toyPublicPublishing();
  const registry = createRegistry([dry, readOnly, internal, publishing.job]);
  const t = testClock();
  const store = new DurableMemoryJobStore({
    keepsValues: false,
    now: t.clock.now,
  });
  const submitted: string[] = [];
  const executor: Executor = {
    async submit(runId) {
      if (options.submitFails) throw new Error('queue down');
      submitted.push(runId);
    },
    async start() {},
    async stop() {},
  };
  const sink = recordingSink();
  const service = new JobsService(
    registry,
    store,
    readsOf(),
    executor,
    t.clock,
    sink,
    publicJobCatalogOf(registry),
    { findById: async () => ({}) },
    new JobInputRefRegistry(),
  );
  /** Finishes the open run on `dedupeKey` in-process, as a worker would. */
  const finish = (dedupeKey: string, tenantId = TENANT_A) =>
    runToCompletion(
      dry,
      {
        input: { typeKey: 'calls', itemCount: 3 },
        tenantId,
        trigger: 'agent',
        requestedBy: null,
        budget: { maxItems: 10 },
        dedupeKey,
        dryRun: true,
      },
      { store, clock: t.base },
    );
  /** Finishes the open publishing run on `dedupeKey`, dry or real as it was started. */
  const finishPublishing = (dedupeKey: string, dryRun: boolean) =>
    runToCompletion(
      publishing.job,
      {
        input: { typeKey: 'calls' },
        tenantId: TENANT_A,
        trigger: 'agent',
        requestedBy: null,
        budget: { maxItems: 10 },
        dedupeKey,
        dryRun,
      },
      { store, clock: t.base },
    );
  return {
    service,
    store,
    submitted,
    sink,
    finish,
    finishPublishing,
    published: publishing.published,
    output: output.state,
    dry,
    internal,
    registry,
    ...t,
  };
}

const expectThrown = async (p: Promise<unknown>) => p.catch((e: unknown) => e);

describe('JobsService', () => {
  describe('audience', () => {
    it('lists and describes only public jobs', () => {
      const { service } = setup();
      expect(service.listJobs(tenantKey()).map((j) => j.key)).toEqual([
        'toy.public-dry',
        'toy.public-read-only',
        'toy.public-publishing',
      ]);
      expect(service.loadJob(tenantKey(), 'toy.public-dry').key).toBe(
        'toy.public-dry',
      );
      expect(() => service.loadJob(admin, 'toy.internal')).toThrow(
        JobNotFoundError,
      );
      expect(() => service.loadJob(admin, 'toy.unknown')).toThrow(
        JobNotFoundError,
      );
    });

    it('lists only the jobs whose runs the caller may read, and refuses one below its read level 403', () => {
      const { service } = setup();
      // toy.public-read-only reads at member; the other two at tenant-wide.
      expect(service.listJobs(member).map((j) => j.key)).toEqual([
        'toy.public-read-only',
      ]);
      expect(service.listJobs(admin).map((j) => j.key)).toEqual([
        'toy.public-dry',
        'toy.public-read-only',
        'toy.public-publishing',
      ]);
      expect(service.loadJob(member, 'toy.public-read-only').key).toBe(
        'toy.public-read-only',
      );
      expect(() => service.loadJob(member, 'toy.public-dry')).toThrow(
        JobAuthorityError,
      );
    });

    it("answers an internal job's start, list, read, wait and cancel as not found, the same as an unknown one", async () => {
      const { service } = setup();
      for (const key of ['toy.internal', 'toy.unknown']) {
        expect(
          await expectThrown(service.start(admin, key, body())),
        ).toBeInstanceOf(JobNotFoundError);
        expect(
          await expectThrown(service.listRuns(admin, key, { limit: 20 })),
        ).toBeInstanceOf(JobNotFoundError);
      }
      const { run: internalRun } = await service.startSystemRun(system, {
        jobKey: 'toy.internal',
        input: { n: 1 },
        trigger: 'manual',
        budget: { maxItems: 1 },
      });
      for (const read of [
        service.loadRun(admin, internalRun.id),
        service.loadRunChange(admin, internalRun.id, { timeoutMs: 0 }),
        service.cancel(admin, internalRun.id),
        service.loadRun(admin, '00000000-0000-4000-8000-000000000000'),
      ])
        expect(await expectThrown(read)).toBeInstanceOf(JobRunNotFoundError);
    });
  });

  describe('authority', () => {
    it('lets a tenant key start a dry run, never a real one', async () => {
      const { service } = setup();
      const started = await service.start(tenantKey(), 'toy.public-dry', body());
      expect(started.created).toBe(true);
      expect(started.run).toMatchObject({
        dryRun: true,
        requestedBy: null,
        trigger: 'agent',
      });
      const real = await expectThrown(
        service.start(tenantKey(), 'toy.public-dry', body({ dry_run: false })),
      );
      expect(real).toBeInstanceOf(JobAuthorityError);
      expect((real as JobAuthorityError).getResponse()).toMatchObject({
        code: 'authority',
        needs: 'admin',
      });
    });

    it('refuses an acting member with no role (t13), and admits an admin member', async () => {
      const { service } = setup();
      expect(
        await expectThrown(service.start(member, 'toy.public-dry', body())),
      ).toBeInstanceOf(JobAuthorityError);
      const real = await service.start(
        admin,
        'toy.public-dry',
        body({ dry_run: false }),
      );
      expect(real.run).toMatchObject({ dryRun: false, requestedBy: ADMIN_ID });
    });

    it("hides a run from a caller below the job's read level, and shows it tenant-wide", async () => {
      const { service } = setup();
      const { run } = await service.start(tenantKey(), 'toy.public-dry', body());
      expect(
        await expectThrown(service.loadRun(member, run.id)),
      ).toBeInstanceOf(JobRunNotFoundError);
      expect(
        await expectThrown(
          service.listRuns(member, 'toy.public-dry', { limit: 20 }),
        ),
      ).toBeInstanceOf(JobAuthorityError);
      expect((await service.loadRun(tenantKey(), run.id)).id).toBe(run.id);
    });

    it("lets a tenant key start a read-only job's real run", async () => {
      const { service } = setup();
      const { run } = await service.start(
        tenantKey(),
        'toy.public-read-only',
        body({ input: {}, dry_run: false }),
      );
      expect(run.dryRun).toBe(false);
      expect((await service.loadRun(member, run.id)).id).toBe(run.id);
    });
  });

  describe('a job with a side-effect step', () => {
    it('lets a tenant key dry-run it, and its dry run publishes nothing', async () => {
      const { service, finishPublishing, published } = setup();
      const dry = await service.start(
        tenantKey(),
        'toy.public-publishing',
        body({ input: { type_key: 'calls' }, dedupe_key: 'pub-dry' }),
      );
      expect(dry.created).toBe(true);
      expect(dry.run.dryRun).toBe(true);
      const done = await finishPublishing('pub-dry', true);
      expect(done.run.status).toBe('completed');
      expect(published).toEqual([]);
      expect((await service.loadRun(tenantKey(), done.run.id)).output).toEqual({
        published: false,
      });
    });

    it('keeps its real run for an admin, and only that run publishes', async () => {
      const { service, finishPublishing, published } = setup();
      expect(
        await expectThrown(
          service.start(
            tenantKey(),
            'toy.public-publishing',
            body({ input: { type_key: 'calls' }, dry_run: false }),
          ),
        ),
      ).toBeInstanceOf(JobAuthorityError);
      const real = await service.start(
        admin,
        'toy.public-publishing',
        body({
          input: { type_key: 'calls' },
          dry_run: false,
          dedupe_key: 'pub-real',
        }),
      );
      const done = await finishPublishing('pub-real', false);
      expect(done.run.status).toBe('completed');
      expect(published).toEqual([`${real.run.id}:calls`]);
    });
  });

  describe('output', () => {
    it('answers null for a completed run whose stored output no longer parses, and logs it', async () => {
      const { service, finish, output } = setup();
      const warn = jest
        .spyOn(
          (service as unknown as { logger: { warn: (m: string) => void } })
            .logger,
          'warn',
        )
        .mockImplementation(() => {});
      await service.start(
        tenantKey(),
        'toy.public-dry',
        body({ dedupe_key: 'drift' }),
      );
      const done = await finish('drift');
      output.load = 'drift';
      const view = await service.loadRun(tenantKey(), done.run.id);
      expect(view.status).toBe('completed');
      expect(view.output).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(done.run.id));
    });

    it("rejects, never answers null, when a completed run's output can't be read", async () => {
      const { service, finish, output } = setup();
      await service.start(
        tenantKey(),
        'toy.public-dry',
        body({ dedupe_key: 'lost' }),
      );
      const done = await finish('lost');
      output.load = 'throw';
      await expect(service.loadRun(tenantKey(), done.run.id)).rejects.toThrow(
        'recorder read failed',
      );
      await expect(
        service.loadRunChange(tenantKey(), done.run.id, { timeoutMs: 0 }),
      ).rejects.toThrow('recorder read failed');
    });
  });

  describe('tenant', () => {
    it("never shows another tenant's run, and names no id in the error", async () => {
      const { service } = setup();
      const { run } = await service.start(
        tenantKey(TENANT_B),
        'toy.public-dry',
        body(),
      );
      for (const read of [
        service.loadRun(tenantKey(), run.id),
        service.loadRunChange(tenantKey(), run.id, { timeoutMs: 0 }),
        service.cancel(tenantKey(), run.id),
      ]) {
        const err = await expectThrown(read);
        expect(err).toBeInstanceOf(JobRunNotFoundError);
        expect(
          JSON.stringify((err as JobRunNotFoundError).getResponse()),
        ).not.toContain(run.id);
      }
      expect(
        (await service.listRuns(tenantKey(), 'toy.public-dry', { limit: 20 }))
          .runs,
      ).toEqual([]);
    });
  });

  describe('input', () => {
    it('converts a snake_case input for the steps', async () => {
      const { service, finish } = setup();
      await service.start(
        tenantKey(),
        'toy.public-dry',
        body({ dedupe_key: 'k1' }),
      );
      const done = await finish('k1');
      expect(done.output).toEqual({ seenKey: 'calls', scoredItems: 3 });
      const view = await service.loadRun(tenantKey(), done.run.id);
      expect(view.status).toBe('completed');
      expect(view.output).toEqual({ seen_key: 'calls', scored_items: 3 });
    });

    it('refuses an invalid input with its paths and codes, never its values', async () => {
      const { service, store } = setup();
      const err = await expectThrown(
        service.start(
          tenantKey(),
          'toy.public-dry',
          body({ input: { type_key: 'sk-secret-value', item_count: 'many' } }),
        ),
      );
      expect(err).toBeInstanceOf(JobInputInvalidError);
      const response = (err as JobInputInvalidError).getResponse();
      expect(response).toMatchObject({
        code: 'input_invalid',
        issues: [{ path: 'item_count', code: 'invalid_type' }],
      });
      expect(JSON.stringify(response)).not.toContain('sk-secret');
      expect(
        await store.listRuns({ tenantId: TENANT_A, limit: 10 }),
      ).toEqual([]);
    });

    it("answers an admit refusal 422 with the job's code, creating no run and holding no key", async () => {
      const { service, store } = setup();
      const err = await expectThrown(
        service.start(
          tenantKey(),
          'toy.public-dry',
          body({ input: { type_key: 'nope', item_count: 1 }, dedupe_key: 'k' }),
        ),
      );
      expect(err).toBeInstanceOf(JobInputRefusedError);
      expect((err as JobInputRefusedError).getStatus()).toBe(422);
      expect((err as JobInputRefusedError).getResponse()).toMatchObject({
        code: 'type_unknown',
      });
      expect(
        await store.listRuns({ tenantId: TENANT_A, limit: 10 }),
      ).toEqual([]);
      const again = await service.start(
        tenantKey(),
        'toy.public-dry',
        body({ dedupe_key: 'k' }),
      );
      expect(again.created).toBe(true);
    });
  });

  describe('budget', () => {
    it('defaults to the limits, with the deadline from the clock', async () => {
      const { service, clock } = setup();
      const { run } = await service.start(tenantKey(), 'toy.public-dry', body());
      expect(run.budget).toEqual({
        maxItems: TOY_LIMITS.maxItems,
        maxUsd: TOY_LIMITS.maxUsd,
        maxCalls: TOY_LIMITS.maxCalls,
        deadlineAt: new Date(
          clock.now().getTime() + TOY_LIMITS.maxDurationMs,
        ).toISOString(),
      });
      const asked = await service.start(
        tenantKey(),
        'toy.public-dry',
        body({ budget: { max_items: 2, max_duration_ms: 1_000 } }),
      );
      expect(asked.run.budget).toMatchObject({
        maxItems: 2,
        deadlineAt: new Date(clock.now().getTime() + 1_000).toISOString(),
      });
    });

    it('refuses a budget over a limit', async () => {
      const { service } = setup();
      const err = await expectThrown(
        service.start(
          tenantKey(),
          'toy.public-dry',
          body({ budget: { max_usd: 2 } }),
        ),
      );
      expect(err).toBeInstanceOf(JobBudgetOverLimitError);
      expect((err as JobBudgetOverLimitError).getResponse()).toMatchObject({
        code: 'budget_over_limit',
        limits: TOY_LIMITS,
      });
    });
  });

  describe('dedupe', () => {
    it('answers the open run on its key with created false, and submits it again', async () => {
      const { service, submitted } = setup();
      const first = await service.start(
        tenantKey(),
        'toy.public-dry',
        body({ dedupe_key: 'd' }),
      );
      const second = await service.start(
        tenantKey(),
        'toy.public-dry',
        body({ dedupe_key: 'd' }),
      );
      expect([first.created, second.created]).toEqual([true, false]);
      expect(second.run.id).toBe(first.run.id);
      expect(submitted).toEqual([first.run.id, first.run.id]);
    });

    it('answers 409 for an open run made by another version', async () => {
      const { service, store } = setup();
      const { run } = await service.start(
        tenantKey(),
        'toy.public-dry',
        body({ dedupe_key: 'd' }),
      );
      const v2 = toyPublicDry({ batchMax: 5 });
      const registry = createRegistry([v2]);
      const next = new JobsService(
        registry,
        store,
        readsOf(),
        { submit: async () => {}, start: async () => {}, stop: async () => {} },
        fakeClock(),
        recordingSink(),
        publicJobCatalogOf(registry),
        { findById: async () => ({}) },
        new JobInputRefRegistry(),
      );
      const err = await expectThrown(
        next.start(tenantKey(), 'toy.public-dry', body({ dedupe_key: 'd' })),
      );
      expect(err).toBeInstanceOf(JobRunVersionConflictError);
      expect((err as JobRunVersionConflictError).getResponse()).toMatchObject({
        code: 'version_conflict',
        runId: run.id,
      });
    });
  });

  it('returns the run when its submit fails, and logs it', async () => {
    const { service, store } = setup({ submitFails: true });
    const warn = jest
      .spyOn(
        (service as unknown as { logger: { warn: (m: string) => void } })
          .logger,
        'warn',
      )
      .mockImplementation(() => {});
    const { run, created } = await service.start(
      tenantKey(),
      'toy.public-dry',
      body(),
    );
    expect(created).toBe(true);
    expect((await store.getRun(run.id)).status).toBe('pending');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(run.id));
  });

  describe('list', () => {
    it('pages by keyset across runs with one createdAt, reading limit + 1', async () => {
      const { service, store } = setup();
      const ids = [];
      for (let i = 0; i < 3; i++)
        ids.push(
          (await service.start(tenantKey(), 'toy.public-dry', body())).run.id,
        );
      const listRuns = jest.spyOn(store, 'listRuns');
      const first = await service.listRuns(tenantKey(), 'toy.public-dry', {
        limit: 2,
      });
      expect(listRuns).toHaveBeenLastCalledWith(
        expect.objectContaining({ limit: 3 }),
      );
      expect(first.runs).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await service.listRuns(tenantKey(), 'toy.public-dry', {
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.nextCursor).toBeNull();
      expect([...first.runs, ...second.runs].map((r) => r.id).sort()).toEqual(
        [...ids].sort(),
      );
      expect(
        new Set([...first.runs, ...second.runs].map((r) => r.createdAt)).size,
      ).toBe(1);
      const stale = await expectThrown(
        service.listRuns(tenantKey(), 'toy.public-dry', {
          limit: 2,
          status: 'pending',
          cursor: first.nextCursor ?? undefined,
        }),
      );
      expect(stale).toBeInstanceOf(JobCursorStaleError);
      const decoded = JSON.parse(
        Buffer.from(first.nextCursor ?? '', 'base64url').toString('utf8'),
      ) as { p: { t: string; i: string }; f: string };
      for (const forged of [
        { ...decoded, p: { ...decoded.p, i: 'x' } },
        { ...decoded, p: { ...decoded.p, t: 'yesterday' } },
        { ...decoded, p: { ...decoded.p, t: '2026-11-15T12:00:00Z' } },
      ]) {
        const err = await expectThrown(
          service.listRuns(tenantKey(), 'toy.public-dry', {
            limit: 2,
            cursor: Buffer.from(JSON.stringify(forged)).toString('base64url'),
          }),
        );
        expect((err as { getStatus(): number }).getStatus()).toBe(400);
        expect((err as { getResponse(): unknown }).getResponse()).toMatchObject(
          {
            code: 'invalid_cursor',
          },
        );
      }
      const malformed = await expectThrown(
        service.listRuns(tenantKey(), 'toy.public-dry', {
          limit: 2,
          cursor: 'not-a-cursor',
        }),
      );
      expect((malformed as { getStatus(): number }).getStatus()).toBe(400);
    });
  });

  describe('wait', () => {
    it('returns at once when after differs from the run', async () => {
      const { service, state } = setup();
      const { run } = await service.start(tenantKey(), 'toy.public-dry', body());
      const view = await service.loadRunChange(tenantKey(), run.id, {
        after: 'older',
        timeoutMs: 30_000,
      });
      expect(view.revision).toBe(run.revision);
      expect(state.sleeps).toBe(0);
    });

    it('holds, then returns within one poll of a change', async () => {
      const { service, state, store } = setup();
      const { run } = await service.start(tenantKey(), 'toy.public-dry', body());
      state.onSleep = async () => {
        if (state.sleeps === 2)
          await store.transition(run.id, { to: 'running', from: 'pending' });
      };
      const view = await service.loadRunChange(tenantKey(), run.id, {
        timeoutMs: 30_000,
      });
      expect(view.status).toBe('running');
      expect(view.revision).not.toBe(run.revision);
      expect(state.sleeps).toBe(2);
    });

    it('returns the run unchanged at the deadline, clamped to the cap', async () => {
      const { service, state, clock } = setup();
      const { run } = await service.start(tenantKey(), 'toy.public-dry', body());
      const start = clock.now().getTime();
      const view = await service.loadRunChange(tenantKey(), run.id, {
        timeoutMs: RUN_WAIT_MAX_MS + 60_000,
      });
      expect(view.revision).toBe(run.revision);
      expect(clock.now().getTime() - start).toBe(RUN_WAIT_MAX_MS);
      expect(state.sleeps).toBe(Math.ceil(RUN_WAIT_MAX_MS / RUN_WAIT_POLL_MS));
    });

    it('returns a terminal run at once, even at its own revision, with its output', async () => {
      const { service, state, finish } = setup();
      await service.start(
        tenantKey(),
        'toy.public-dry',
        body({ dedupe_key: 'w' }),
      );
      const done = await finish('w');
      const current = await service.loadRun(tenantKey(), done.run.id);
      const sleeps = state.sleeps;
      const view = await service.loadRunChange(tenantKey(), done.run.id, {
        after: current.revision,
        timeoutMs: 30_000,
      });
      expect(view.status).toBe('completed');
      expect(view.output).toEqual({ seen_key: 'calls', scored_items: 3 });
      expect(state.sleeps).toBe(sleeps);
    });

    it('stops polling once the caller goes away', async () => {
      const { service, state } = setup();
      const { run } = await service.start(tenantKey(), 'toy.public-dry', body());
      const abort = new AbortController();
      state.onSleep = async () => abort.abort();
      const view = await service.loadRunChange(
        tenantKey(),
        run.id,
        { timeoutMs: 30_000 },
        abort.signal,
      );
      expect(view.revision).toBe(run.revision);
      expect(state.sleeps).toBe(1);
    });

    it("refuses the ninth concurrent wait of one tenant, not another's", async () => {
      const { service, holdSleeps, releaseSleeps } = setup();
      const { run } = await service.start(tenantKey(), 'toy.public-dry', body());
      const other = await service.start(
        tenantKey(TENANT_B),
        'toy.public-dry',
        body(),
      );
      holdSleeps();
      const held = Array.from({ length: MAX_RUN_WAITS_PER_TENANT }, () =>
        service.loadRunChange(tenantKey(), run.id, { timeoutMs: 4_000 }),
      );
      await new Promise((r) => setTimeout(r, 10));
      const ninth = await expectThrown(
        service.loadRunChange(tenantKey(), run.id, { timeoutMs: 0 }),
      );
      expect(ninth).toBeInstanceOf(TooManyRunWaitsError);
      expect((ninth as TooManyRunWaitsError).getStatus()).toBe(429);
      const otherTenant = service.loadRunChange(tenantKey(TENANT_B), other.run.id, {
        timeoutMs: 0,
      });
      releaseSleeps();
      await Promise.all([...held, otherTenant]);
      expect(
        (await service.loadRunChange(tenantKey(), run.id, { timeoutMs: 0 })).id,
      ).toBe(run.id);
    });

    it("answers another tenant's run before any sleep", async () => {
      const { service, state } = setup();
      const { run } = await service.start(
        tenantKey(TENANT_B),
        'toy.public-dry',
        body(),
      );
      expect(
        await expectThrown(
          service.loadRunChange(tenantKey(), run.id, { timeoutMs: 30_000 }),
        ),
      ).toBeInstanceOf(JobRunNotFoundError);
      expect(state.sleeps).toBe(0);
    });
  });

  describe('cancel', () => {
    it('cancels a dry run by its level, emitting run.canceled, and answers a repeat with the run', async () => {
      const { service, sink } = setup();
      const { run } = await service.start(tenantKey(), 'toy.public-dry', body());
      expect((await service.cancel(tenantKey(), run.id)).status).toBe('canceled');
      expect(sink.types()).toContain('run.canceled');
      expect((await service.cancel(tenantKey(), run.id)).status).toBe('canceled');
      expect(sink.types().filter((t) => t === 'run.canceled')).toHaveLength(1);
    });

    it('refuses a real run to tenant-wide, and a completed run to anyone', async () => {
      const { service, finish } = setup();
      const real = await service.start(
        admin,
        'toy.public-dry',
        body({ dry_run: false }),
      );
      expect(
        await expectThrown(service.cancel(tenantKey(), real.run.id)),
      ).toBeInstanceOf(JobAuthorityError);
      await service.start(
        tenantKey(),
        'toy.public-dry',
        body({ dedupe_key: 'c' }),
      );
      const done = await finish('c');
      const ended = await expectThrown(service.cancel(admin, done.run.id));
      expect(ended).toBeInstanceOf(JobRunEndedError);
      expect((ended as JobRunEndedError).getResponse()).toMatchObject({
        code: 'run_ended',
        status: 'completed',
      });
    });
  });
});
