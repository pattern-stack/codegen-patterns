/**
 * `JobStarter` (JOBS-3): the run's tenant (the caller's; omitted, the ambient requester's; else `SYSTEM_TENANT`),
 * no submit in a process that is no worker (its job code would run with no lease heartbeat), and a failed submit
 * logged, not thrown (the run exists; the sweep resubmits it).
 */
import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { defineJob, step, SYSTEM_TENANT } from '@pattern-stack/jobs';
import { JOBS_EXECUTOR, JOBS_STORE } from '@pattern-stack/jobs/nest';
import { MemoryJobStore } from '@pattern-stack/jobs/testing';
import { z } from 'zod';

import { withRequester } from '../../../../runtime/base-classes/tenant-context';
import { DRIZZLE } from '../../../../runtime/constants/tokens';
import { JobsEngineModule } from '../../../../runtime/subsystems/jobs/jobs-engine.module';
import { JobStarter } from '../../../../runtime/subsystems/jobs/job-starter';

const job = defineJob({
  key: 'toy.start',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  limits: { maxItems: 1, maxUsd: 1, maxCalls: 1, maxDurationMs: 60_000 },
  steps: (s) => s.add('ok', step({ run: () => ({ ok: true }) })),
});

@Global()
@Module({ providers: [{ provide: DRIZZLE, useValue: {} }], exports: [DRIZZLE] })
class FakeDatabaseModule {}

/**
 * `JobStarter` as the app's container builds it, from `JobsEngineModule.forRoot` (review #969: built by hand with
 * `worker: false`, the spec could not see that the container never handed it `JOBS_WORKER`). Only the store and the
 * executor are replaced, so nothing reaches a database and the submits are counted.
 */
async function starterWith(opts: { worker?: boolean; submitFails?: boolean } = {}) {
  const submitted: string[] = [];
  const executor = {
    async submit(runId: string) {
      if (opts.submitFails) throw new Error('connection reset');
      submitted.push(runId);
    },
    async start() {},
    async stop() {},
  };
  const moduleRef = await Test.createTestingModule({
    imports: [FakeDatabaseModule, JobsEngineModule.forRoot({ definitions: [job], worker: opts.worker ?? true })],
  })
    .overrideProvider(JOBS_STORE)
    .useValue(new MemoryJobStore())
    .overrideProvider(JOBS_EXECUTOR)
    .useValue(executor)
    .compile();
  return { starter: moduleRef.get(JobStarter), submitted };
}

const requester = (tenantId: string | null) => ({
  userId: 'u-1',
  organizationId: null,
  tenantId,
  scope: 'user' as const,
});

describe('JobStarter — the run tenant', () => {
  it("the caller's tenant wins", async () => {
    const { starter } = await starterWith();
    const { run } = await withRequester(requester('t-ambient'), () => starter.start('toy.start', {}, { tenantId: 't-1' }));
    expect(run.tenantId).toBe('t-1');
  });

  it("omitted, the ambient requester's tenant — a start inside a tenant's request stays in its partition", async () => {
    const { starter } = await starterWith();
    const { run } = await withRequester(requester('t-ambient'), () => starter.start('toy.start', {}));
    expect(run.tenantId).toBe('t-ambient');
  });

  it('explicit null, or no requester at all, is SYSTEM_TENANT', async () => {
    const { starter } = await starterWith();
    expect((await withRequester(requester('t-ambient'), () => starter.start('toy.start', {}, { tenantId: null }))).run.tenantId).toBe(
      SYSTEM_TENANT,
    );
    expect((await starter.start('toy.start', {})).run.tenantId).toBe(SYSTEM_TENANT);
  });
});

describe('JobStarter — submit', () => {
  it('a worker process submits the run to its executor', async () => {
    const { starter, submitted } = await starterWith({ worker: true });
    const { run } = await starter.start('toy.start', {});
    expect(submitted).toEqual([run.id]);
  });

  it("a process that is no worker (JobsEngineModule.forRoot({ worker: false })) does not submit: the worker's sweep takes the run", async () => {
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
