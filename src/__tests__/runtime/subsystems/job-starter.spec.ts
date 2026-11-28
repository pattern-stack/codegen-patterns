/**
 * The two starters (JOBS-3, J-1): `JobRunStarter` (framework-free, a pattern-stack app's) and Nest's `JobStarter` (an
 * adapter over `JobsService.startSystemRun`), both the package's one system start (`@pattern-stack/jobs/host`). Each
 * holds the run's tenant (the caller's; omitted, the ambient requester's; else `SYSTEM_TENANT`), no submit in a
 * process that is no worker (its job code would run with no lease heartbeat), and a failed submit logged, not thrown
 * (the run exists; the sweep resubmits it). Nest's is built by the container `JobsEngineModule.forRoot` makes (review
 * #969: built by hand, the spec could not see that the container never handed it `JOBS_WORKER`).
 */
import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { BadRequestException, Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createRegistry, defineJob, step, SYSTEM_TENANT, systemClock } from '@pattern-stack/jobs';
import { JOBS_EXECUTOR, JOBS_STORE } from '@pattern-stack/jobs/nest';
import { MemoryJobStore } from '@pattern-stack/jobs/testing';
import { z } from 'zod';

import { withRequester } from '../../../../runtime/base-classes/tenant-context';
import { DRIZZLE } from '../../../../runtime/constants/tokens';
import { JobRunStarter } from '../../../../runtime/subsystems/jobs/job-run-starter';
import { JobStarter } from '../../../../runtime/subsystems/jobs/job-starter';
import { JobsEngineModule } from '../../../../runtime/subsystems/jobs/jobs-engine.module';

const job = defineJob({
  key: 'toy.start',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  limits: { maxItems: 1, maxUsd: 1, maxCalls: 1, maxDurationMs: 60_000 },
  steps: (s) => s.add('ok', step({ run: () => ({ ok: true }) })),
});
const unlimited = defineJob({
  key: 'toy.unlimited',
  input: z.object({}),
  output: z.object({}),
  steps: (s) => s.add('ok', step({ run: () => ({}) })),
});

@Global()
@Module({ providers: [{ provide: DRIZZLE, useValue: {} }], exports: [DRIZZLE] })
class FakeDatabaseModule {}

type Opts = { worker?: boolean; submitFails?: boolean };
type Starter = Pick<JobRunStarter, 'start'>;

function executorWith(opts: Opts) {
  const submitted: string[] = [];
  const executor = {
    async submit(runId: string) {
      if (opts.submitFails) throw new Error('connection reset');
      submitted.push(runId);
    },
    async start() {},
    async stop() {},
  };
  return { executor, submitted };
}

const STARTERS: Record<string, (opts: Opts) => Promise<{ starter: Starter; submitted: string[] }>> = {
  JobRunStarter: async (opts) => {
    const { executor, submitted } = executorWith(opts);
    const starter = new JobRunStarter({
      registry: createRegistry([job, unlimited]),
      store: new MemoryJobStore(),
      executor: executor as never,
      tables: {} as never,
      clock: systemClock,
      events: { emit: () => undefined },
      worker: opts.worker,
    });
    return { starter, submitted };
  },
  'JobStarter (from JobsEngineModule.forRoot)': async (opts) => {
    const { executor, submitted } = executorWith(opts);
    const moduleRef = await Test.createTestingModule({
      imports: [FakeDatabaseModule, JobsEngineModule.forRoot({ definitions: [job, unlimited], worker: opts.worker ?? true })],
    })
      .overrideProvider(JOBS_STORE)
      .useValue(new MemoryJobStore())
      .overrideProvider(JOBS_EXECUTOR)
      .useValue(executor)
      .compile();
    return { starter: moduleRef.get(JobStarter), submitted };
  },
};

const requester = (tenantId: string | null) => ({
  userId: 'u-1',
  organizationId: null,
  tenantId,
  scope: 'user' as const,
});

for (const [name, starterWith] of Object.entries(STARTERS)) {
  describe(`${name} — the run tenant`, () => {
    it("the caller's tenant wins", async () => {
      const { starter } = await starterWith({});
      const { run } = await withRequester(requester('t-ambient'), () => starter.start('toy.start', {}, { tenantId: 't-1' }));
      expect(run.tenantId).toBe('t-1');
    });

    it("omitted, the ambient requester's tenant — a start inside a tenant's request stays in its partition", async () => {
      const { starter } = await starterWith({});
      const { run } = await withRequester(requester('t-ambient'), () => starter.start('toy.start', {}));
      expect(run.tenantId).toBe('t-ambient');
    });

    it('explicit null, or no requester at all, is SYSTEM_TENANT', async () => {
      const { starter } = await starterWith({});
      expect(
        (await withRequester(requester('t-ambient'), () => starter.start('toy.start', {}, { tenantId: null }))).run.tenantId,
      ).toBe(SYSTEM_TENANT);
      expect((await starter.start('toy.start', {})).run.tenantId).toBe(SYSTEM_TENANT);
    });
  });

  describe(`${name} — submit`, () => {
    it('a worker process submits the run to its executor', async () => {
      const { starter, submitted } = await starterWith({ worker: true });
      const { run } = await starter.start('toy.start', {});
      expect(submitted).toEqual([run.id]);
    });

    it("a process that is no worker does not submit: the worker's sweep takes the run", async () => {
      const { starter, submitted } = await starterWith({ worker: false });
      const { run } = await starter.start('toy.start', {});
      expect(run.status).toBe('pending');
      expect(submitted).toEqual([]);
    });

    it('a failed submit is not thrown: the run was created, and the sweep resubmits it', async () => {
      const { starter } = await starterWith({ worker: true, submitFails: true });
      const { run, created } = await starter.start('toy.start', {});
      expect(created).toBe(true);
      expect(run.id).toBeTruthy();
    });
  });
}

describe('the budget refusal, per host', () => {
  it("a job with no limits and no budget is Nest's 400 budget_required; the plain starter's is a JobBudgetError", async () => {
    const nest = await STARTERS['JobStarter (from JobsEngineModule.forRoot)']!({});
    await expect(nest.starter.start('toy.unlimited', {})).rejects.toBeInstanceOf(BadRequestException);
    const plain = await STARTERS.JobRunStarter!({});
    await expect(plain.starter.start('toy.unlimited', {})).rejects.toMatchObject({ name: 'JobBudgetError', code: 'budget_required' });
  });
});
