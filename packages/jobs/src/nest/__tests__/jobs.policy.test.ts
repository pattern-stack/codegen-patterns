import { describe, expect, it } from 'bun:test';
import { HttpException } from '@nestjs/common';
import { startRunRequestShape } from '../../shapes/index.ts';
import { jobsOpsStartInputSchema } from '../../shapes/ops.ts';
import { createRegistry, type Run } from '../../index.ts';
import type { Executor } from '../../ports.ts';
import {
  fakeClock,
  MemoryJobStore,
  recordingSink,
  toyInternal,
  toyPublicDry,
  toyPublicPublishing,
  toyPublicReadOnly,
} from '../../testing.ts';
import type {
  JobActor,
  JobOperatorActor,
  JobSystemActor,
  TenantJobActor,
} from '../job-actor.ts';
import {
  JobAuthorityError,
  JobNotFoundError,
  JobRunNotFoundError,
} from '../jobs.errors.ts';
import { jobsServiceOf, readsOf } from './service-fixture.ts';

/** §1B's table: each action against each actor kind, one case per cell. */

const TENANT_A = '0a000000-0000-4000-8000-00000000000a';
const TENANT_B = '0b000000-0000-4000-8000-00000000000b';
const USER = '11111111-1111-4111-8111-111111111111';

const member: TenantJobActor = {
  kind: 'member',
  tenantId: TENANT_A,
  userId: USER,
};
const apiKey: TenantJobActor = { kind: 'apiKey', tenantId: TENANT_A };
const admin: TenantJobActor = {
  kind: 'admin',
  tenantId: TENANT_A,
  userId: USER,
};
const operator: JobOperatorActor = { kind: 'operator', userId: USER };
const system: JobSystemActor = {
  kind: 'system',
  tenantId: TENANT_A,
  userId: null,
};
const systemB: JobSystemActor = {
  kind: 'system',
  tenantId: TENANT_B,
  userId: null,
};

const body = (wire: Record<string, unknown> = {}) =>
  startRunRequestShape.fromPublic(
    startRunRequestShape.public.parse({
      input: { type_key: 'calls', item_count: 2 },
      ...wire,
    }),
  );

function setup() {
  const registry = createRegistry([
    toyPublicDry(),
    toyPublicReadOnly(),
    toyInternal(),
    toyPublicPublishing().job,
  ]);
  const clock = fakeClock();
  const store = new (class extends MemoryJobStore {
    override readonly durability = 'durable' as const;
  })({ keepsValues: false, now: clock.now });
  const executor: Executor = {
    submit: async () => {},
    start: async () => {},
    stop: async () => {},
  };
  const service = jobsServiceOf({
    registry,
    store,
    executor,
    clock,
    events: recordingSink(),
    reads: readsOf({ listNewestRunsPerJob: async () => [] }),
    tenants: { findById: async (id) => (id === TENANT_A ? { id } : null) },
  });
  return { service, store };
}

const thrown = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    return err;
  }
  return undefined;
};

/** A cast past the view's type: a plain Error (a 500 no client can reach), never a client answer. */
const expectWrongKind = (err: unknown) => {
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(HttpException);
};

const as = (actor: JobActor) => actor as never;

describe('the jobs policy', () => {
  it('list jobs: each tenant kind sees the public jobs its level reads', () => {
    const { service } = setup();
    const keys = (a: TenantJobActor) => service.listJobs(a).map((j) => j.key);
    expect(keys(member)).toEqual(['toy.public-read-only']);
    expect(keys(apiKey).sort()).toEqual([
      'toy.public-dry',
      'toy.public-publishing',
      'toy.public-read-only',
    ]);
    expect(keys(admin)).toEqual(keys(apiKey));
  });

  it('read a job: 403 below its read level, 404 for an internal one', async () => {
    const { service } = setup();
    expect(
      await thrown(() => service.loadJob(member, 'toy.public-dry')),
    ).toBeInstanceOf(JobAuthorityError);
    expect(service.loadJob(apiKey, 'toy.public-dry').key).toBe(
      'toy.public-dry',
    );
    expect(service.loadJob(admin, 'toy.public-dry').key).toBe('toy.public-dry');
    for (const a of [member, apiKey, admin])
      expect(
        await thrown(() => service.loadJob(a, 'toy.internal')),
      ).toBeInstanceOf(JobNotFoundError);
  });

  it("list a job's runs: 403 below read, scoped to the actor's tenant", async () => {
    const { service } = setup();
    expect(
      await thrown(service.listRuns(member, 'toy.public-dry', { limit: 5 })),
    ).toBeInstanceOf(JobAuthorityError);
    await service.start(apiKey, 'toy.public-dry', body());
    expect(
      (await service.listRuns(apiKey, 'toy.public-dry', { limit: 5 })).runs,
    ).toHaveLength(1);
    expect(
      (
        await service.listRuns(
          { ...apiKey, tenantId: TENANT_B },
          'toy.public-dry',
          { limit: 5 },
        )
      ).runs,
    ).toEqual([]);
  });

  it("start: the job's dryRun or start level by kind", async () => {
    const { service } = setup();
    expect(
      await thrown(service.start(member, 'toy.public-dry', body())),
    ).toBeInstanceOf(JobAuthorityError);
    expect(
      (await service.start(apiKey, 'toy.public-dry', body())).created,
    ).toBe(true);
    expect(
      await thrown(
        service.start(apiKey, 'toy.public-dry', body({ dry_run: false })),
      ),
    ).toBeInstanceOf(JobAuthorityError);
    expect(
      (await service.start(admin, 'toy.public-dry', body({ dry_run: false })))
        .run.dryRun,
    ).toBe(false);
  });

  it('start records the member, never the tenant key', async () => {
    const { service, store } = setup();
    const byKey = await service.start(
      apiKey,
      'toy.public-dry',
      body({ dedupe_key: 'k' }),
    );
    const byAdmin = await service.start(
      admin,
      'toy.public-dry',
      body({ dedupe_key: 'a' }),
    );
    expect((await store.getRun(byKey.run.id)).requestedBy).toBeNull();
    expect((await store.getRun(byAdmin.run.id)).requestedBy).toBe(USER);
  });

  it('read a run: its tenant, a public job, at read; every miss the same 404', async () => {
    const { service } = setup();
    const { run } = await service.start(apiKey, 'toy.public-dry', body());
    expect((await service.loadRun(apiKey, run.id)).id).toBe(run.id);
    expect((await service.loadRun(admin, run.id)).id).toBe(run.id);
    expect(await thrown(service.loadRun(member, run.id))).toBeInstanceOf(
      JobRunNotFoundError,
    );
    expect(
      await thrown(
        service.loadRun({ ...admin, tenantId: TENANT_B }, run.id),
      ),
    ).toBeInstanceOf(JobRunNotFoundError);
    const internal = await service.startSystemRun(system, {
      jobKey: 'toy.internal',
      input: { n: 1 },
      trigger: 'manual',
      budget: { maxItems: 1 },
    });
    expect(
      await thrown(service.loadRun(admin, internal.run.id)),
    ).toBeInstanceOf(JobRunNotFoundError);
  });

  it('a process that is no worker starts a run but never submits it (the worker\'s sweep takes it)', async () => {
    const submitted: string[] = [];
    const registry = createRegistry([toyInternal()]);
    const clock = fakeClock();
    const service = jobsServiceOf({
      registry,
      store: new MemoryJobStore({ now: clock.now }),
      executor: { submit: async (id: string) => void submitted.push(id), start: async () => {}, stop: async () => {} },
      clock,
      events: recordingSink(),
      worker: false,
    });
    const started = await service.startSystemRun(system, { jobKey: 'toy.internal', input: { n: 1 }, trigger: 'manual', budget: { maxItems: 1 } });
    expect(started.run.status).toBe('pending');
    expect(submitted).toEqual([]);
  });

  it("cancel: a visible run at its start level (a dry run's dryRun level)", async () => {
    const { service } = setup();
    const dry = await service.start(
      apiKey,
      'toy.public-dry',
      body({ dedupe_key: 'd' }),
    );
    expect((await service.cancel(apiKey, dry.run.id)).status).toBe('canceled');
    const real = await service.start(
      admin,
      'toy.public-dry',
      body({ dry_run: false, dedupe_key: 'r' }),
    );
    expect(await thrown(service.cancel(apiKey, real.run.id))).toBeInstanceOf(
      JobAuthorityError,
    );
    expect(await thrown(service.cancel(member, real.run.id))).toBeInstanceOf(
      JobRunNotFoundError,
    );
    expect((await service.cancel(admin, real.run.id)).status).toBe('canceled');
  });

  it('the operator reaches every registered job, internal ones too, with no ceiling', async () => {
    const { service } = setup();
    const { jobs } = await service.listJobsWithHealth(operator);
    expect(jobs.map((j) => j.key)).toContain('toy.internal');
    const started = await service.startForTenant(
      operator,
      jobsOpsStartInputSchema.parse({
        jobKey: 'toy.internal',
        tenantId: TENANT_A,
        input: { n: 1 },
        budget: { maxItems: 1_000_000 },
      }),
    );
    expect(started.run.tenantId).toBe(TENANT_A);
    expect((await service.loadRunRecord(operator, started.run.id)).run.id).toBe(
      started.run.id,
    );
  });

  it("the system reaches its tenant's registered jobs, internal ones too, with no job authority", async () => {
    const { service, store } = setup();
    const internal = await service.startSystemRun(system, {
      jobKey: 'toy.internal',
      input: { n: 1 },
      trigger: 'manual',
      budget: { maxItems: 1 },
    });
    expect(internal.run.tenantId).toBe(TENANT_A);
    expect(internal.run.requestedBy).toBeNull();
    // No ceiling and no level: a real run of a public job a tenant key could not start.
    const real = await service.startSystemRun(
      { ...system, userId: USER },
      {
        jobKey: 'toy.public-dry',
        input: { typeKey: 'calls', itemCount: 2 },
        trigger: 'manual',
        dryRun: false,
      },
    );
    expect((await store.getRun(real.run.id)).requestedBy).toBe(USER);
    expect((await service.loadSystemRun(system, internal.run.id)).id).toBe(
      internal.run.id,
    );
    expect(
      await thrown(service.loadSystemRun(systemB, internal.run.id)),
    ).toBeInstanceOf(JobRunNotFoundError);
    expect(await service.openGate(system, 'ai-switch')).toEqual([]);
  });

  it("a wrong kind past a view's type is a plain Error, never a client answer", async () => {
    const { service } = setup();
    const run: Run = (
      await service.startSystemRun(system, {
        jobKey: 'toy.internal',
        input: { n: 1 },
        trigger: 'manual',
        budget: { maxItems: 1 },
      })
    ).run;
    for (const wrong of [operator, system])
      expectWrongKind(await thrown(() => service.listJobs(as(wrong))));
    for (const wrong of [member, apiKey, admin, system])
      expectWrongKind(await thrown(service.listJobsWithHealth(as(wrong))));
    for (const wrong of [member, operator])
      expectWrongKind(await thrown(service.loadSystemRun(as(wrong), run.id)));
    expectWrongKind(await thrown(service.openGate(as(admin), 'x')));
  });
});
