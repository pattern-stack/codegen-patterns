/**
 * `JobStarter` (JOBS-3): the run's tenant (the caller's; omitted, the ambient requester's; else `SYSTEM_TENANT`),
 * no submit in a process that is no worker (its job code would run with no lease heartbeat), and a failed submit
 * logged, not thrown (the run exists; the sweep resubmits it).
 */
import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { createRegistry, defineJob, step, SYSTEM_TENANT, systemClock } from '@pattern-stack/jobs';
import { MemoryJobStore } from '@pattern-stack/jobs/testing';
import { z } from 'zod';

import { withRequester } from '../../../../runtime/base-classes/tenant-context';
import { JobStarter } from '../../../../runtime/subsystems/jobs/job-starter';

const job = defineJob({
  key: 'toy.start',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  limits: { maxItems: 1, maxUsd: 1, maxCalls: 1, maxDurationMs: 60_000 },
  steps: (s) => s.add('ok', step({ run: () => ({ ok: true }) })),
});

function starterWith(opts: { worker?: boolean; submitFails?: boolean } = {}) {
  const submitted: string[] = [];
  const executor = {
    async submit(runId: string) {
      if (opts.submitFails) throw new Error('connection reset');
      submitted.push(runId);
    },
  };
  const starter = new JobStarter(
    createRegistry([job]),
    new MemoryJobStore(),
    executor as never,
    {} as never,
    systemClock,
    { emit: () => undefined },
    undefined,
    opts.worker,
  );
  return { starter, submitted };
}

const requester = (tenantId: string | null) => ({
  userId: 'u-1',
  organizationId: null,
  tenantId,
  scope: 'user' as const,
});

describe('JobStarter — the run tenant', () => {
  it("the caller's tenant wins", async () => {
    const { starter } = starterWith();
    const { run } = await withRequester(requester('t-ambient'), () => starter.start('toy.start', {}, { tenantId: 't-1' }));
    expect(run.tenantId).toBe('t-1');
  });

  it("omitted, the ambient requester's tenant — a start inside a tenant's request stays in its partition", async () => {
    const { starter } = starterWith();
    const { run } = await withRequester(requester('t-ambient'), () => starter.start('toy.start', {}));
    expect(run.tenantId).toBe('t-ambient');
  });

  it('explicit null, or no requester at all, is SYSTEM_TENANT', async () => {
    const { starter } = starterWith();
    expect((await withRequester(requester('t-ambient'), () => starter.start('toy.start', {}, { tenantId: null }))).run.tenantId).toBe(
      SYSTEM_TENANT,
    );
    expect((await starter.start('toy.start', {})).run.tenantId).toBe(SYSTEM_TENANT);
  });
});

describe('JobStarter — submit', () => {
  it('a worker process submits the run to its executor', async () => {
    const { starter, submitted } = starterWith({ worker: true });
    const { run } = await starter.start('toy.start', {});
    expect(submitted).toEqual([run.id]);
  });

  it("a process that is no worker does not submit: the worker's sweep takes the run", async () => {
    const { starter, submitted } = starterWith({ worker: false });
    const { run } = await starter.start('toy.start', {});
    expect(run.status).toBe('pending');
    expect(submitted).toEqual([]);
  });

  it('a failed submit is not thrown: the run was created, and the sweep resubmits it', async () => {
    const { starter } = starterWith({ worker: true, submitFails: true });
    const { run, created } = await starter.start('toy.start', {});
    expect(created).toBe(true);
    expect(run.id).toBeTruthy();
  });
});
