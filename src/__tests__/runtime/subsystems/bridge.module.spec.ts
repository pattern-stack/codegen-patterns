/**
 * BridgeModule unit tests (BRIDGE-8).
 *
 * Covers:
 *   - `forRoot({ backend: 'memory' })` boots in `Test.createTestingModule`
 *     and resolves all six exported tokens.
 *   - `forRoot({ backend: 'drizzle' })` boots against a mocked DRIZZLE
 *     token; `BRIDGE_DELIVERY_REPO` is a `DrizzleBridgeDeliveryRepo`.
 *   - `multiTenant: true` populates `BRIDGE_MULTI_TENANT` correctly.
 *   - Boot-time pool check (`onModuleInit`):
 *       - `JobWorkerModule` not present → no throw (skipped).
 *       - `JobWorkerModule` present with all three reserved pools → no throw.
 *       - `JobWorkerModule` present missing one or more reserved pools →
 *         throws `BridgeReservedPoolsNotPolledError` listing every missing
 *         pool.
 *   - Site (c) — `DrizzleBridgeDeliveryRepo.insertDelivery` throws
 *     `MissingTenantIdError` BEFORE any SQL is issued when
 *     `multiTenant=true` + `tenantId === undefined`. (Sites (a) and (b)
 *     are pinned by BRIDGE-7's `event-flow.service.spec.ts` and BRIDGE-5's
 *     `bridge-delivery-handler.spec.ts` and continue to pass post-helper
 *     refactor.)
 */
import 'reflect-metadata';
import { describe, expect, it, mock } from 'bun:test';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/pg-proxy';

import {
  BridgeModule,
  BRIDGE_DELIVERY_REPO,
  BRIDGE_MODULE_OPTIONS,
  BRIDGE_MULTI_TENANT,
  BRIDGE_OUTBOX_DRAIN_HOOK,
  BRIDGE_REGISTRY,
  BRIDGE_RESERVED_POOLS,
  BridgeReservedPoolsNotPolledError,
  DrizzleBridgeDeliveryRepo,
  EVENT_FLOW,
  EventFlowService,
  MemoryBridgeDeliveryRepo,
  MissingTenantIdError,
  type BridgeDeliveryInsert,
} from '../../../../runtime/subsystems/bridge';
import { EventsModule } from '../../../../runtime/subsystems/events/events.module';
import { JobsDomainModule } from '../../../../runtime/subsystems/jobs/jobs-domain.module';
import { DRIZZLE } from '../../../../runtime/constants/tokens';
import {
  JOB_WORKER_MODULE_OPTIONS,
  type JobWorkerModuleOptions,
} from '../../../../runtime/subsystems/jobs/job-worker.module';
import type { DrizzleClient } from '../../../../runtime/types/drizzle';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * `EventFlowService` injects `DRIZZLE` unconditionally (its
 * `publishAndStart` opens a tx); we provide a stub here so memory-backend
 * module tests can resolve the facade without spinning up Postgres. The
 * stub is never invoked in these tests (no `publishAndStart` call) but
 * the DI wire-up demands it.
 */
@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useValue: {
        transaction: () => {
          throw new Error(
            'stub DRIZZLE — publishAndStart not exercised in this test',
          );
        },
      },
    },
  ],
  exports: [DRIZZLE],
})
class FakeDrizzleStubModule {}

/**
 * Mount the prerequisite sibling modules (events + jobs) in memory mode so
 * `BridgeModule` can resolve `EVENT_BUS` / `JOB_ORCHESTRATOR` / etc. via DI.
 * Mirrors the `EventsModule + JobsDomainModule + BridgeModule` layering the
 * consumer wires per ADR-023.
 */
function siblingsMemory() {
  return [
    FakeDrizzleStubModule,
    EventsModule.forRoot({ backend: 'memory' }),
    JobsDomainModule.forRoot({ backend: 'memory' }),
  ];
}

/**
 * Drizzle-shaped mock — captures issued SQL so we can assert the multi-
 * tenancy guard fires BEFORE any SQL is sent. Same shape used by
 * `bridge-delivery.drizzle-backend.spec.ts`.
 */
function makeCapturingDb() {
  const captures: Array<{ sql: string; params: unknown[]; method: string }> = [];
  const db = drizzle(async (sql, params, method) => {
    captures.push({ sql, params, method });
    return { rows: [] };
  }) as unknown as DrizzleClient;
  return { db, captures };
}

/**
 * Provide a mocked `JOB_WORKER_MODULE_OPTIONS` so `BridgeModule.onModuleInit`
 * sees an "active" worker module without us actually mounting
 * `JobWorkerModule.forRoot()` (which would spin up real workers).
 */
function workerOptionsModule(opts: JobWorkerModuleOptions) {
  @Global()
  @Module({
    providers: [{ provide: JOB_WORKER_MODULE_OPTIONS, useValue: opts }],
    exports: [JOB_WORKER_MODULE_OPTIONS],
  })
  class FakeWorkerOptionsModule {}
  return FakeWorkerOptionsModule;
}

// ─── Memory backend ──────────────────────────────────────────────────────────

describe('BridgeModule.forRoot({ backend: "memory" })', () => {
  it('boots and resolves all six exported tokens', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ...siblingsMemory(),
        BridgeModule.forRoot({ backend: 'memory' }),
      ],
    }).compile();

    expect(moduleRef.get(EVENT_FLOW)).toBeInstanceOf(EventFlowService);
    expect(moduleRef.get(BRIDGE_DELIVERY_REPO)).toBeInstanceOf(
      MemoryBridgeDeliveryRepo,
    );
    expect(moduleRef.get(BRIDGE_REGISTRY)).toBeDefined();
    expect(moduleRef.get(BRIDGE_MULTI_TENANT)).toBe(false);
    expect(moduleRef.get(BRIDGE_MODULE_OPTIONS)).toEqual({ backend: 'memory' });
    expect(moduleRef.get(BRIDGE_OUTBOX_DRAIN_HOOK)).toBeDefined();

    await moduleRef.close();
  });

  it('marks the module global so consumer modules see the tokens transitively', async () => {
    @Module({})
    class ConsumerModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        ...siblingsMemory(),
        BridgeModule.forRoot({ backend: 'memory' }),
        ConsumerModule,
      ],
    }).compile();

    expect(moduleRef.get(EVENT_FLOW)).toBeInstanceOf(EventFlowService);
    const dyn = BridgeModule.forRoot({ backend: 'memory' });
    expect(dyn.global).toBe(true);

    await moduleRef.close();
  });

  it('multiTenant: true populates BRIDGE_MULTI_TENANT correctly', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ...siblingsMemory(),
        BridgeModule.forRoot({ backend: 'memory', multiTenant: true }),
      ],
    }).compile();

    expect(moduleRef.get(BRIDGE_MULTI_TENANT)).toBe(true);

    await moduleRef.close();
  });

  it('multiTenant defaults to false when omitted', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ...siblingsMemory(),
        BridgeModule.forRoot({ backend: 'memory' }),
      ],
    }).compile();

    expect(moduleRef.get(BRIDGE_MULTI_TENANT)).toBe(false);

    await moduleRef.close();
  });
});

// ─── Drizzle backend ─────────────────────────────────────────────────────────

describe('BridgeModule.forRoot({ backend: "drizzle" })', () => {
  it('boots against a mocked DRIZZLE token and resolves DrizzleBridgeDeliveryRepo', async () => {
    const { db } = makeCapturingDb();

    @Global()
    @Module({
      providers: [{ provide: DRIZZLE, useValue: db }],
      exports: [DRIZZLE],
    })
    class FakeDrizzleModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDrizzleModule,
        EventsModule.forRoot({ backend: 'drizzle' }),
        JobsDomainModule.forRoot({ backend: 'drizzle' }),
        BridgeModule.forRoot({ backend: 'drizzle' }),
      ],
    }).compile();

    expect(moduleRef.get(BRIDGE_DELIVERY_REPO)).toBeInstanceOf(
      DrizzleBridgeDeliveryRepo,
    );
    expect(moduleRef.get(EVENT_FLOW)).toBeInstanceOf(EventFlowService);
    expect(moduleRef.get(BRIDGE_REGISTRY)).toBeDefined();
    expect(moduleRef.get(BRIDGE_OUTBOX_DRAIN_HOOK)).toBeDefined();
    expect(moduleRef.get(BRIDGE_MULTI_TENANT)).toBe(false);

    await moduleRef.close();
  });
});

// ─── Boot-time reserved-pool check ───────────────────────────────────────────

describe('BridgeModule.onModuleInit — reserved-pool boot check', () => {
  it('does not throw when JobWorkerModule is not wired (token absent)', async () => {
    // No FakeWorkerOptionsModule → JOB_WORKER_MODULE_OPTIONS is undefined →
    // the @Optional() inject resolves to undefined → boot check is skipped.
    const moduleRef = await Test.createTestingModule({
      imports: [
        ...siblingsMemory(),
        BridgeModule.forRoot({ backend: 'memory' }),
      ],
    }).compile();

    await expect(moduleRef.init()).resolves.toBeDefined();
    await moduleRef.close();
  });

  it('does not throw when JobWorkerModule polls all three reserved pools', async () => {
    const FakeWorker = workerOptionsModule({
      mode: 'embedded',
      backend: 'memory',
      pools: ['interactive', 'batch', ...BRIDGE_RESERVED_POOLS],
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeWorker,
        ...siblingsMemory(),
        BridgeModule.forRoot({ backend: 'memory' }),
      ],
    }).compile();

    await expect(moduleRef.init()).resolves.toBeDefined();
    await moduleRef.close();
  });

  it('short-circuits to pass when worker module sets allPools (BULLMQ-1)', async () => {
    const FakeWorker = workerOptionsModule({
      mode: 'standalone',
      backend: 'memory',
      allPools: true,
      // No explicit reserved pools listed — `allPools` proves they are polled.
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeWorker,
        ...siblingsMemory(),
        BridgeModule.forRoot({ backend: 'memory' }),
      ],
    }).compile();

    await expect(moduleRef.init()).resolves.toBeDefined();
    await moduleRef.close();
  });

  it('throws BridgeReservedPoolsNotPolledError when reserved pools are missing', async () => {
    const FakeWorker = workerOptionsModule({
      mode: 'embedded',
      backend: 'memory',
      pools: ['interactive', 'batch'], // no reserved pools at all
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeWorker,
        ...siblingsMemory(),
        BridgeModule.forRoot({ backend: 'memory' }),
      ],
    }).compile();

    let caught: unknown = null;
    try {
      await moduleRef.init();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BridgeReservedPoolsNotPolledError);
    const msg = (caught as Error).message;
    for (const p of BRIDGE_RESERVED_POOLS) {
      expect(msg).toContain(p);
    }
    expect((caught as BridgeReservedPoolsNotPolledError).missingPools).toEqual([
      ...BRIDGE_RESERVED_POOLS,
    ]);

    await moduleRef.close().catch(() => {});
  });

  it('throws naming only the missing pool when one of the three is absent', async () => {
    const FakeWorker = workerOptionsModule({
      mode: 'embedded',
      backend: 'memory',
      // Two of three reserved pools — `events_outbound` is missing.
      pools: ['interactive', 'events_inbound', 'events_change'],
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeWorker,
        ...siblingsMemory(),
        BridgeModule.forRoot({ backend: 'memory' }),
      ],
    }).compile();

    let caught: unknown = null;
    try {
      await moduleRef.init();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BridgeReservedPoolsNotPolledError);
    expect(
      (caught as BridgeReservedPoolsNotPolledError).missingPools,
    ).toEqual(['events_outbound']);
    expect((caught as Error).message).toContain('events_outbound');

    await moduleRef.close().catch(() => {});
  });

  it('treats undefined pools as "no pools" (defensive — same throw as empty list)', async () => {
    const FakeWorker = workerOptionsModule({
      mode: 'embedded',
      backend: 'memory',
      // pools omitted entirely
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeWorker,
        ...siblingsMemory(),
        BridgeModule.forRoot({ backend: 'memory' }),
      ],
    }).compile();

    await expect(moduleRef.init()).rejects.toBeInstanceOf(
      BridgeReservedPoolsNotPolledError,
    );
    await moduleRef.close().catch(() => {});
  });
});

// ─── Multi-tenancy site (c) — DrizzleBridgeDeliveryRepo.insertDelivery ───────

describe('DrizzleBridgeDeliveryRepo.insertDelivery — site (c) multi-tenancy', () => {
  const ROW_BASE: BridgeDeliveryInsert = {
    id: '00000000-0000-0000-0000-000000000001',
    eventId: '00000000-0000-0000-0000-000000000002',
    triggerId: 'send_welcome_email#0',
    status: 'pending',
  };

  it('throws MissingTenantIdError BEFORE any SQL when multiTenant=true and tenantId undefined', async () => {
    const { db, captures } = makeCapturingDb();
    const repo = new DrizzleBridgeDeliveryRepo(db, /* multiTenant */ true);

    // tenantId omitted entirely → undefined → site (c) trips.
    await expect(repo.insertDelivery({ ...ROW_BASE })).rejects.toBeInstanceOf(
      MissingTenantIdError,
    );
    expect(captures).toHaveLength(0);
  });

  it('error message names the canonical site string', async () => {
    const { db } = makeCapturingDb();
    const repo = new DrizzleBridgeDeliveryRepo(db, true);
    let caught: unknown = null;
    try {
      await repo.insertDelivery({ ...ROW_BASE });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingTenantIdError);
    expect((caught as MissingTenantIdError).callSite).toBe(
      'DrizzleBridgeDeliveryRepo.insertDelivery',
    );
  });

  it('passes explicit null tenantId — opts into cross-tenant work', async () => {
    const { db, captures } = makeCapturingDb();
    const repo = new DrizzleBridgeDeliveryRepo(db, true);
    await repo.insertDelivery({ ...ROW_BASE, tenantId: null });
    expect(captures).toHaveLength(1);
    expect(captures[0]!.sql.toLowerCase()).toContain(
      'insert into "bridge_delivery"',
    );
  });

  it('passes explicit string tenantId', async () => {
    const { db, captures } = makeCapturingDb();
    const repo = new DrizzleBridgeDeliveryRepo(db, true);
    await repo.insertDelivery({ ...ROW_BASE, tenantId: 'tenant-9' });
    expect(captures).toHaveLength(1);
    expect(captures[0]!.params).toContain('tenant-9');
  });

  it('multiTenant=false (default) — undefined tenantId is allowed', async () => {
    const { db, captures } = makeCapturingDb();
    // Default `multiTenant` arg = false (matches @Optional() default).
    const repo = new DrizzleBridgeDeliveryRepo(db);
    await repo.insertDelivery({ ...ROW_BASE });
    expect(captures).toHaveLength(1);
  });

  // Silence "mock is unused" noise from the importer when this file gets
  // touched without a mock-using test in scope.
  void mock;
});
