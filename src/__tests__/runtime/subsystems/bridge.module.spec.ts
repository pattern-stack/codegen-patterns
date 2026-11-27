/**
 * BridgeModule unit tests (BRIDGE-8).
 *
 * Covers:
 *   - `forRoot({ backend: 'memory' })` boots in `Test.createTestingModule`
 *     and resolves all six exported tokens.
 *   - `forRoot({ backend: 'drizzle' })` boots against a mocked DRIZZLE
 *     token; `BRIDGE_DELIVERY_REPO` is a `DrizzleBridgeDeliveryRepo`.
 *   - `multiTenant: true` populates `BRIDGE_MULTI_TENANT` correctly.
 *   - (JOBS-3: there is no reserved-pool boot check; the drain starts each
 *     run with `JobStarter`, so there are no `events_*` pools to poll.)
 *   - Site (c) — `DrizzleBridgeDeliveryRepo.insertDelivery` throws
 *     `MissingTenantIdError` BEFORE any SQL is issued when
 *     `multiTenant=true` + `tenantId === undefined`. (Site (a) is pinned
 *     by `event-flow.service.spec.ts`.)
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
  DrizzleBridgeDeliveryRepo,
  EVENT_FLOW,
  EventFlowService,
  MemoryBridgeDeliveryRepo,
  MissingTenantIdError,
  type BridgeDeliveryInsert,
  type BridgeRegistry,
} from '../../../../runtime/subsystems/bridge';
import { EventsModule } from '../../../../runtime/subsystems/events/events.module';
import { JobStarter } from '../../../../runtime/subsystems/jobs/job-starter';
import { DRIZZLE } from '../../../../runtime/constants/tokens';
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
 * The jobs side BridgeModule needs: `JobStarter` (which `JobsEngineModule` provides, globally). A stub, since these
 * tests never start a run and `JobsEngineModule` needs a Postgres store.
 */
@Global()
@Module({
  providers: [
    {
      provide: JobStarter,
      useValue: {
        has: () => true,
        start: () => {
          throw new Error('stub JobStarter — no run is started in this test');
        },
      },
    },
  ],
  exports: [JobStarter],
})
class FakeJobsModule {}

/**
 * Mount the prerequisite sibling modules (events + jobs) in memory mode so
 * `BridgeModule` can resolve `EVENT_BUS` / `JobStarter` / etc. via DI.
 * Mirrors the `EventsModule + JobsEngineModule + BridgeModule` layering the
 * consumer wires per ADR-023.
 */
function siblingsMemory() {
  return [FakeDrizzleStubModule, EventsModule.forRoot({ backend: 'memory' }), FakeJobsModule];
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

// ─── Registry override (ADR-037 package mode) ────────────────────────────────
//
// Package-mode consumers can't reach the bundled `./generated/registry`
// placeholder ({}), so the generated subsystem barrel threads their scanned
// registry in via `forRoot({ registry })`. The provider must prefer that over
// the bundle; omitting it must still resolve (vendored / tests fall back to the
// bundled empty registry).
describe('BridgeModule.forRoot — registry override', () => {
  const customRegistry = {
    contact_created: [
      {
        triggerId: 'send_welcome_email#0',
        jobType: 'send_welcome_email',
        map: (e: unknown) => e,
      },
    ],
  } as unknown as BridgeRegistry;

  it('binds the supplied registry to BRIDGE_REGISTRY (package mode path)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ...siblingsMemory(),
        BridgeModule.forRoot({ backend: 'memory', registry: customRegistry }),
      ],
    }).compile();

    expect(moduleRef.get(BRIDGE_REGISTRY)).toBe(customRegistry);

    await moduleRef.close();
  });

  it('falls back to the bundled empty registry when `registry` is omitted', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ...siblingsMemory(),
        BridgeModule.forRoot({ backend: 'memory' }),
      ],
    }).compile();

    // Bundled placeholder is `{}` — resolvable + empty (NOT the custom one).
    expect(moduleRef.get(BRIDGE_REGISTRY)).toEqual({});
    expect(moduleRef.get(BRIDGE_REGISTRY)).not.toBe(customRegistry);

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
        FakeJobsModule,
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
