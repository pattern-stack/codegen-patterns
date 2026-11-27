import { describe, expect, it, mock } from 'bun:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  JOB_HEALTH_WINDOW,
  jobsOpsStartInputSchema,
} from '../../shapes/ops.ts';
import { createRegistry, type Run, runToCompletion } from '../../index.ts';
import type { Executor } from '../../ports.ts';
import type {
  JobOperatorReads,
  JobRecentRun,
  OperatorItem,
  StoredJobEvent,
} from '../../postgres.ts';
import {
  fakeClock,
  MemoryJobStore,
  recordingSink,
  toyInternal,
  toyPublicDry,
} from '../../testing.ts';
import type { JobOperatorActor } from '../job-actor.ts';
import {
  type JobInputRefOption,
  JobInputRefRegistry,
  type JobInputRefSource,
} from '../job-input-refs.ts';
import { JobCursorStaleError } from '../jobs.errors.ts';
import { JobsService } from '../jobs.service.ts';
import { publicJobCatalogOf } from '../public-job-catalog.ts';

const TENANT_A = '0a000000-0000-4000-8000-00000000000a';
const TENANT_B = '0b000000-0000-4000-8000-00000000000b';
const OPERATOR: JobOperatorActor = {
  kind: 'operator',
  userId: '99999999-9999-4999-8999-999999999999',
};

const startInput = (wire: Record<string, unknown>) =>
  jobsOpsStartInputSchema.parse(wire);

const expectThrown = async (p: Promise<unknown>) => p.catch((e: unknown) => e);

/** An operator read as a recorded mock: its calls, and an answer a test can queue. */
function readMock<A extends unknown[], R>(empty: R) {
  return mock(async (..._args: A): Promise<R> => empty);
}

function setup() {
  const dry = toyPublicDry();
  const internal = toyInternal();
  const registry = createRegistry([dry, internal]);
  const clock = fakeClock();
  const store = new MemoryJobStore({ keepsValues: false, now: clock.now });
  const submitted: string[] = [];
  const executor: Executor = {
    async submit(runId) {
      submitted.push(runId);
    },
    async start() {},
    async stop() {},
  };
  const sink = recordingSink();
  const reads = {
    listRecentAcrossTenants: readMock<
      Parameters<JobOperatorReads['listRecentAcrossTenants']>,
      Run[]
    >([]),
    listRunsAcrossTenants: readMock<
      Parameters<JobOperatorReads['listRunsAcrossTenants']>,
      Run[]
    >([]),
    listNewestRunsPerJob: readMock<
      Parameters<JobOperatorReads['listNewestRunsPerJob']>,
      JobRecentRun[]
    >([]),
    listRunItems: readMock<
      Parameters<JobOperatorReads['listRunItems']>,
      OperatorItem[]
    >([]),
    listRunEvents: readMock<
      Parameters<JobOperatorReads['listRunEvents']>,
      StoredJobEvent[]
    >([]),
    listEvents: readMock<
      Parameters<JobOperatorReads['listEvents']>,
      StoredJobEvent[]
    >([]),
  } satisfies JobOperatorReads;
  const known = new Set([TENANT_A, TENANT_B]);
  const tenants = {
    findById: mock(async (id: string) => (known.has(id) ? { id } : null)),
  };
  const search = mock(
    async (
      ..._args: Parameters<NonNullable<JobInputRefSource['listOptions']>>
    ): Promise<JobInputRefOption[]> => [
      {
        id: '44444444-4444-4444-8444-444444444444',
        label: 'Champion',
        hint: 'v2',
      },
    ],
  );
  // A registry with fake sources registered, so a new kind needs no edit here.
  const refs = new JobInputRefRegistry();
  for (const kind of ['document', 'playVersion', 'signalVersion'])
    refs.register({
      kind,
      label: 'thing',
      listOptions: search,
      resolve: async (_tenantId, ids) =>
        ids.map((id) => ({ id, label: 'thing', hint: '' })),
    });
  const service = new JobsService(
    registry,
    store,
    reads,
    executor,
    clock,
    sink,
    publicJobCatalogOf(registry),
    tenants,
    refs,
  );
  return {
    service,
    store,
    reads,
    submitted,
    sink,
    dry,
    internal,
    clock,
    search,
  };
}

describe('JobsService, the operator view', () => {
  describe('start', () => {
    it('refuses a tenant that does not exist, creating nothing', async () => {
      const { service, store, submitted } = setup();
      const err = await expectThrown(
        service.startForTenant(
          OPERATOR,
          startInput({
            jobKey: 'toy.internal',
            tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            input: { n: 1 },
            budget: { maxItems: 1 },
          }),
        ),
      );
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).getResponse()).toMatchObject({
        code: 'tenant_not_found',
      });
      expect(
        await store.listRuns({ tenantId: TENANT_A, limit: 10 }),
      ).toEqual([]);
      expect(submitted).toEqual([]);
    });

    it('starts an internal job as the operator and submits it', async () => {
      const { service, submitted } = setup();
      const { run, created } = await service.startForTenant(
        OPERATOR,
        startInput({
          jobKey: 'toy.internal',
          tenantId: TENANT_A,
          input: { n: 2 },
          budget: { maxItems: 1 },
        }),
      );
      expect(created).toBe(true);
      expect(run).toMatchObject({
        jobKey: 'toy.internal',
        tenantId: TENANT_A,
        requestedBy: OPERATOR.userId,
        trigger: 'manual',
        dryRun: false,
        cache: 'read-write',
      });
      expect(submitted).toEqual([run.id]);
    });

    it('starts a refresh when asked, and says the mode it ran under', async () => {
      const { service } = setup();
      const { run } = await service.startForTenant(
        OPERATOR,
        startInput({
          jobKey: 'toy.internal',
          tenantId: TENANT_A,
          input: { n: 2 },
          budget: { maxItems: 1 },
          cache: 'refresh',
        }),
      );
      expect(run.cache).toBe('refresh');
    });

    it("needs maxItems for a job with no limits, and defaults to a job's limits otherwise", async () => {
      const { service } = setup();
      const err = await expectThrown(
        service.startForTenant(
          OPERATOR,
          startInput({
            jobKey: 'toy.internal',
            tenantId: TENANT_A,
            input: { n: 1 },
          }),
        ),
      );
      expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
        code: 'budget_required',
      });
      const { run } = await service.startForTenant(
        OPERATOR,
        startInput({
          jobKey: 'toy.public-dry',
          tenantId: TENANT_A,
          input: { typeKey: 'calls', itemCount: 1 },
        }),
      );
      expect(run.budget.maxItems).toBe(10);
    });

    it('says why the job refused the input, as a 400 input_invalid', async () => {
      const { service } = setup();
      const refused = await expectThrown(
        service.startForTenant(
          OPERATOR,
          startInput({
            jobKey: 'toy.public-dry',
            tenantId: TENANT_A,
            input: { typeKey: 'calls', itemCount: 'many' },
          }),
        ),
      );
      expect(refused).toBeInstanceOf(BadRequestException);
      expect((refused as BadRequestException).getResponse()).toEqual({
        message: expect.stringMatching(
          /^The job refused this input: .*itemCount: invalid_type/,
        ),
        code: 'input_invalid',
      });
    });

    it("answers a job's admit refusal and an unknown job as client errors", async () => {
      const { service } = setup();
      const refused = await expectThrown(
        service.startForTenant(
          OPERATOR,
          startInput({
            jobKey: 'toy.public-dry',
            tenantId: TENANT_A,
            input: { typeKey: 'nope', itemCount: 1 },
          }),
        ),
      );
      expect((refused as { getStatus(): number }).getStatus()).toBe(400);
      const unknown = await expectThrown(
        service.startForTenant(
          OPERATOR,
          startInput({
            jobKey: 'toy.nope',
            tenantId: TENANT_A,
            input: {},
          }),
        ),
      );
      expect(unknown).toBeInstanceOf(NotFoundException);
    });
  });

  describe('actions', () => {
    it("pauses, resumes and cancels a run by its id alone, under the run's own tenant", async () => {
      const { service, sink, submitted } = setup();
      const { run } = await service.startForTenant(
        OPERATOR,
        startInput({
          jobKey: 'toy.internal',
          tenantId: TENANT_B,
          input: { n: 1 },
          budget: { maxItems: 1 },
        }),
      );
      const paused = await service.controlRun(OPERATOR, run.id, 'pause');
      expect(paused).toMatchObject({
        changed: true,
        run: { status: 'paused', pauseReason: 'operator' },
      });
      const resumed = await service.controlRun(OPERATOR, run.id, 'resume');
      expect(resumed).toMatchObject({
        changed: true,
        run: { status: 'running', tenantId: TENANT_B },
      });
      expect(submitted).toEqual([run.id, run.id]);
      const canceled = await service.controlRun(OPERATOR, run.id, 'cancel');
      expect(canceled.run.status).toBe('canceled');
      expect(
        await service.controlRun(OPERATOR, run.id, 'cancel'),
      ).toMatchObject({ changed: false });
      expect(sink.events.map((e) => e.type)).toEqual([
        'run.paused',
        'run.resumed',
        'run.canceled',
      ]);
      expect(sink.events.every((e) => e.tenantId === TENANT_B)).toBe(true);
    });

    it('answers an unknown run 404 for every action and read', async () => {
      const { service } = setup();
      const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      for (const p of [
        service.controlRun(OPERATOR, id, 'pause'),
        service.controlRun(OPERATOR, id, 'resume'),
        service.controlRun(OPERATOR, id, 'cancel'),
        service.loadRunRecord(OPERATOR, id),
        service.listRunItems(OPERATOR, { runId: id, step: 'only', limit: 10 }),
        service.listRunEvents(OPERATOR, { runId: id, limit: 10 }),
      ])
        expect(await expectThrown(p)).toBeInstanceOf(NotFoundException);
    });
  });

  describe('reads', () => {
    it("shows a completed run's steps and output", async () => {
      const { service, store, internal, clock } = setup();
      const outcome = await runToCompletion(
        internal,
        {
          input: { n: 4 },
          tenantId: TENANT_A,
          trigger: 'manual',
          requestedBy: null,
          budget: { maxItems: 1 },
        },
        { store, clock },
      );
      const view = await service.loadRunRecord(OPERATOR, outcome.run.id);
      expect(view.run.status).toBe('completed');
      expect(view.run.steps.map((s) => [s.name, s.status])).toEqual([
        ['only', 'completed'],
      ]);
      expect(view).toMatchObject({ output: 4, outputUnreadable: false });
    });

    it('pages runs with a cursor bound to its filters', async () => {
      const { service, reads } = setup();
      const run = (id: string, at: number) =>
        ({
          id,
          tenantId: TENANT_A,
          jobKey: 'toy.internal',
          jobVersion: 'v',
          status: 'completed',
          pauseReason: null,
          trigger: 'manual',
          requestedBy: null,
          dryRun: false,
          dedupeKey: null,
          subject: null,
          budget: { maxItems: 1 },
          spend: { calls: 0, inputTokens: 0, costUsd: 0 },
          reservedUsd: 0,
          error: null,
          chunkSize: 1000,
          chunkConcurrency: null,
          cache: 'read-write',
          parentRunId: null,
          parentStep: null,
          childKey: null,
          depth: 0,
          createdAt: new Date(at),
          startedAt: null,
          completedAt: null,
        }) satisfies Run;
      reads.listRunsAcrossTenants.mockResolvedValueOnce([
        run('11111111-1111-4111-8111-111111111111', 3000),
        run('22222222-2222-4222-8222-222222222222', 2000),
      ]);
      const first = await service.listRunsAcrossTenants(OPERATOR, {
        jobKey: 'toy.internal',
        limit: 1,
      });
      expect(reads.listRunsAcrossTenants).toHaveBeenCalledWith({
        jobKey: 'toy.internal',
        tenantId: undefined,
        status: undefined,
        before: undefined,
        limit: 2,
      });
      expect(first.runs).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      await service.listRunsAcrossTenants(OPERATOR, {
        jobKey: 'toy.internal',
        cursor: first.nextCursor ?? undefined,
        limit: 1,
      });
      expect(reads.listRunsAcrossTenants).toHaveBeenLastCalledWith(
        expect.objectContaining({
          before: {
            at: new Date(3000),
            id: '11111111-1111-4111-8111-111111111111',
          },
        }),
      );
      expect(
        await expectThrown(
          service.listRunsAcrossTenants(OPERATOR, {
            jobKey: 'toy.public-dry',
            cursor: first.nextCursor ?? undefined,
            limit: 1,
          }),
        ),
      ).toBeInstanceOf(JobCursorStaleError);
      // The subject is a filter the cursor is bound to, and each row says its run's subject.
      const about = { kind: 'document', id: 'iv-1' };
      reads.listRunsAcrossTenants.mockResolvedValueOnce([
        {
          ...run('33333333-3333-4333-8333-333333333333', 4000),
          subject: about,
        },
        run('44444444-4444-4444-8444-444444444444', 1000),
      ]);
      const mine = await service.listRunsAcrossTenants(OPERATOR, {
        jobKey: 'toy.internal',
        subject: about,
        limit: 1,
      });
      expect(reads.listRunsAcrossTenants).toHaveBeenLastCalledWith(
        expect.objectContaining({ subject: about }),
      );
      expect(mine.runs[0]?.subject).toEqual(about);
      expect(
        await expectThrown(
          service.listRunsAcrossTenants(OPERATOR, {
            jobKey: 'toy.internal',
            subject: { kind: 'document', id: 'iv-2' },
            cursor: mine.nextCursor ?? undefined,
            limit: 1,
          }),
        ),
      ).toBeInstanceOf(JobCursorStaleError);
    });

    it("lists every registered job, internal ones too, with the server's health", async () => {
      const { service, reads } = setup();
      const recent = (
        status: JobRecentRun['status'],
        at: number,
        ms?: number,
      ): JobRecentRun => ({
        jobKey: 'toy.internal',
        id: `11111111-1111-4111-8111-${String(at).padStart(12, '0')}`,
        tenantId: TENANT_A,
        status,
        createdAt: new Date(at),
        startedAt: new Date(at),
        completedAt: ms === undefined ? null : new Date(at + ms),
      });
      reads.listNewestRunsPerJob.mockResolvedValueOnce([
        recent('running', 5000),
        recent('failed', 4000, 5),
        recent('completed', 3000, 10),
        recent('completed', 2000, 12),
      ]);
      const { jobs } = await service.listJobsWithHealth(OPERATOR);
      expect(jobs.map((j) => [j.key, j.audience])).toEqual([
        ['toy.internal', 'internal'],
        ['toy.public-dry', 'public'],
      ]);
      expect(reads.listNewestRunsPerJob).toHaveBeenCalledWith(
        ['toy.public-dry', 'toy.internal'],
        JOB_HEALTH_WINDOW,
      );
      expect(jobs[0]?.health).toEqual({
        window: 4,
        open: 1,
        completed: 2,
        failed: 1,
        canceled: 0,
        successRate: 2 / 3,
        durationMs: { avg: 11, p50: 10, max: 12 },
        lastRun: {
          id: '11111111-1111-4111-8111-000000005000',
          tenantId: TENANT_A,
          status: 'running',
          createdAt: new Date(5000).toISOString(),
          completedAt: null,
        },
      });
      expect(jobs[1]?.health).toMatchObject({ window: 0, successRate: null });
      expect(jobs[1]?.steps.map((s) => s.kind)).toEqual([
        'step',
        'map',
        'step',
      ]);
    });
  });

  describe('refOptions', () => {
    it('looks up inside the tenant the form names, at the asked limit', async () => {
      const { service, search } = setup();
      const answer = await service.listRefOptions(OPERATOR, {
        ref: 'document',
        tenantId: TENANT_B,
        q: 'champ',
        limit: 7,
      });
      expect(search).toHaveBeenCalledWith(TENANT_B, 'champ', 7);
      expect(answer.options).toHaveLength(1);
    });

    it('refuses a tenant that does not exist, looking nothing up', async () => {
      const { service, search } = setup();
      const err = await expectThrown(
        service.listRefOptions(OPERATOR, {
          ref: 'playVersion',
          tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          limit: 20,
        }),
      );
      expect((err as NotFoundException).getResponse()).toMatchObject({
        code: 'tenant_not_found',
      });
      expect(search).not.toHaveBeenCalled();
    });
  });
});
