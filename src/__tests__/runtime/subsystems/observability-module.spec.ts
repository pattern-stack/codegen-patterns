/**
 * ObservabilityModule unit tests (ADR-008, 5th subsystem).
 *
 * Verifies the `forRoot` factory wires the right backend under each of:
 *   - `backend: 'memory'`       (tests / CI)
 *   - `backend: 'drizzle'`      (production — mock DRIZZLE provider)
 *   - `reporters.bridgeMetrics` (opt-in reporter registration)
 *
 * Also drives the smoke path from the epic #195 acceptance criteria: the
 * module boots under BOTH backends and exposes `IObservabilityService`
 * via the OBSERVABILITY token.
 */
import 'reflect-metadata';
import { describe, expect, it, mock } from 'bun:test';
import { Test } from '@nestjs/testing';
import { Global, Module } from '@nestjs/common';
import { ObservabilityModule } from '../../../../runtime/subsystems/observability/observability.module';
import {
  OBSERVABILITY,
  OBSERVABILITY_REPORTERS,
} from '../../../../runtime/subsystems/observability/observability.tokens';
import { DrizzleObservabilityService } from '../../../../runtime/subsystems/observability/observability.drizzle-backend';
import { MemoryObservabilityService } from '../../../../runtime/subsystems/observability/observability.memory-backend';
import { BridgeMetricsReporter } from '../../../../runtime/subsystems/observability/reporters/bridge-metrics.reporter';
import { DRIZZLE } from '../../../../runtime/constants/tokens';

describe('ObservabilityModule.forRoot — backend selection', () => {
  it('resolves OBSERVABILITY to MemoryObservabilityService for backend: memory', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ObservabilityModule.forRoot({ backend: 'memory' })],
    }).compile();

    expect(moduleRef.get(OBSERVABILITY)).toBeInstanceOf(
      MemoryObservabilityService,
    );
    await moduleRef.close();
  });

  it('resolves OBSERVABILITY to DrizzleObservabilityService for backend: drizzle (with DRIZZLE provided)', async () => {
    @Global()
    @Module({
      providers: [{ provide: DRIZZLE, useValue: {} }],
      exports: [DRIZZLE],
    })
    class FakeDrizzleModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDrizzleModule,
        ObservabilityModule.forRoot({ backend: 'drizzle' }),
      ],
    }).compile();

    expect(moduleRef.get(OBSERVABILITY)).toBeInstanceOf(
      DrizzleObservabilityService,
    );
    await moduleRef.close();
  });

  it('returns a global DynamicModule that exports OBSERVABILITY', () => {
    const dyn = ObservabilityModule.forRoot({ backend: 'memory' });
    expect(dyn.global).toBe(true);
    expect(dyn.exports).toContain(OBSERVABILITY);
  });

  it('defaults backend to drizzle when options omitted', () => {
    const dyn = ObservabilityModule.forRoot();
    // The default path requires DRIZZLE at boot; we only assert the
    // DynamicModule shape here — the provider map includes the drizzle
    // concrete class.
    const providers = (dyn.providers ?? []) as unknown[];
    const hasDrizzle = providers.some(
      (p) => p === DrizzleObservabilityService,
    );
    expect(hasDrizzle).toBe(true);
  });
});

describe('ObservabilityModule.forRoot — reporters gate', () => {
  it('does NOT register BridgeMetricsReporter by default', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ObservabilityModule.forRoot({ backend: 'memory' })],
    }).compile();

    // Resolving an unregistered provider throws — assert that happens.
    expect(() => moduleRef.get(BridgeMetricsReporter)).toThrow();
    expect(moduleRef.get(OBSERVABILITY_REPORTERS)).toEqual({});
    await moduleRef.close();
  });

  it('registers BridgeMetricsReporter when reporters.bridgeMetrics=true', async () => {
    @Global()
    @Module({
      providers: [{ provide: DRIZZLE, useValue: {} }],
      exports: [DRIZZLE],
    })
    class FakeDrizzleModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDrizzleModule,
        ObservabilityModule.forRoot({
          backend: 'drizzle',
          reporters: { bridgeMetrics: true },
        }),
      ],
    }).compile();

    const reporter = moduleRef.get(BridgeMetricsReporter);
    expect(reporter).toBeInstanceOf(BridgeMetricsReporter);
    expect(moduleRef.get(OBSERVABILITY_REPORTERS)).toEqual({
      bridgeMetrics: true,
    });
    await moduleRef.close();
  });
});

describe('MemoryObservabilityService — core contract', () => {
  it('returns seeded pool depths', async () => {
    const svc = new MemoryObservabilityService();
    svc.seedPools([
      { name: 'default', pending: 2, running: 1, claimedAgeP95Ms: 500 },
    ]);
    const result = await svc.getPoolDepths();
    expect(result).toEqual([
      { name: 'default', pending: 2, running: 1, claimedAgeP95Ms: 500 },
    ]);
  });

  it('returns empty array when no pools seeded', async () => {
    const svc = new MemoryObservabilityService();
    expect(await svc.getPoolDepths()).toEqual([]);
  });

  it('filters recent sync runs by integrationId', async () => {
    const svc = new MemoryObservabilityService();
    const now = Date.now();
    svc.seedSyncRuns([
      makeSyncRun({ id: 'a', integrationId: 'i-1', startedAt: new Date(now - 1000) }),
      makeSyncRun({ id: 'b', integrationId: 'i-2', startedAt: new Date(now - 2000) }),
      makeSyncRun({ id: 'c', integrationId: 'i-1', startedAt: new Date(now - 500) }),
    ]);

    const i1Only = await svc.getRecentSyncRuns(10, 'i-1');
    expect(i1Only.map((r) => r.id)).toEqual(['c', 'a']);

    const all = await svc.getRecentSyncRuns(10);
    expect(all.map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('respects limit on recent sync runs', async () => {
    const svc = new MemoryObservabilityService();
    const now = Date.now();
    svc.seedSyncRuns([
      makeSyncRun({ id: 'a', startedAt: new Date(now - 1000) }),
      makeSyncRun({ id: 'b', startedAt: new Date(now - 500) }),
      makeSyncRun({ id: 'c', startedAt: new Date(now - 100) }),
    ]);
    const runs = await svc.getRecentSyncRuns(2);
    expect(runs.map((r) => r.id)).toEqual(['c', 'b']);
  });

  it('returns the seeded bridge histogram', async () => {
    const svc = new MemoryObservabilityService();
    svc.seedBridgeHistogram({ delivered: 3, skipped: 1 });
    expect(await svc.getBridgeDeliveryHistogram(24)).toEqual({
      delivered: 3,
      skipped: 1,
    });
  });

  it('sorts failed jobs newest-first and respects limit', async () => {
    const svc = new MemoryObservabilityService();
    svc.seedFailedJobs([
      makeFailedJob({ id: '1', finishedAt: new Date(1_000) }),
      makeFailedJob({ id: '2', finishedAt: new Date(3_000) }),
      makeFailedJob({ id: '3', finishedAt: new Date(2_000) }),
    ]);
    const jobs = await svc.getRecentFailedJobs(2);
    expect(jobs.map((j) => j.id)).toEqual(['2', '3']);
  });

  it('returns seeded cursors', async () => {
    const svc = new MemoryObservabilityService();
    svc.seedCursors([
      {
        subscriptionId: 's-1',
        integrationId: 'i-1',
        adapter: 'salesforce',
        domain: 'opportunity',
        lastCursor: { systemModstamp: '2024-01-01T00:00:00Z' },
        lastSyncAt: new Date(),
      },
    ]);
    const cursors = await svc.getCursors();
    expect(cursors).toHaveLength(1);
    expect(cursors[0]!.adapter).toBe('salesforce');
  });

  it('reset() clears every slice', async () => {
    const svc = new MemoryObservabilityService();
    svc.seedPools([{ name: 'p', pending: 1, running: 0, claimedAgeP95Ms: null }]);
    svc.seedBridgeHistogram({ delivered: 5 });
    svc.reset();
    expect(await svc.getPoolDepths()).toEqual([]);
    expect(await svc.getBridgeDeliveryHistogram(1)).toEqual({});
  });
});

describe('ObservabilityModule — smoke: boots under both backends end-to-end', () => {
  it('memory backend: module compiles and protocol reads return', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ObservabilityModule.forRoot({ backend: 'memory' })],
    }).compile();

    const svc = moduleRef.get(OBSERVABILITY) as MemoryObservabilityService;
    expect(await svc.getPoolDepths()).toEqual([]);
    expect(await svc.getRecentSyncRuns(5)).toEqual([]);
    expect(await svc.getBridgeDeliveryHistogram(24)).toEqual({});
    expect(await svc.getRecentFailedJobs(5)).toEqual([]);
    expect(await svc.getCursors()).toEqual([]);

    await moduleRef.close();
  });

  it('drizzle backend: module compiles with DRIZZLE mock and exposes the drizzle backend', async () => {
    // Mock db for a query that would otherwise hit Postgres. The drizzle
    // backend calls `db.execute(sql`...`)` for pool depths — we stub it.
    const db = {
      execute: mock(async () => ({ rows: [] })),
      select: mock(() => ({
        from: mock(() => ({
          innerJoin: mock(() => ({
            where: mock(() => ({
              orderBy: mock(() => ({
                limit: mock(async () => []),
              })),
            })),
            orderBy: mock(() => ({
              limit: mock(async () => []),
            })),
          })),
          where: mock(() => ({
            orderBy: mock(() => ({
              limit: mock(async () => []),
            })),
          })),
        })),
      })),
    };

    @Global()
    @Module({
      providers: [{ provide: DRIZZLE, useValue: db }],
      exports: [DRIZZLE],
    })
    class FakeDrizzleModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDrizzleModule,
        ObservabilityModule.forRoot({ backend: 'drizzle' }),
      ],
    }).compile();

    const svc = moduleRef.get(OBSERVABILITY);
    expect(svc).toBeInstanceOf(DrizzleObservabilityService);

    // Drives at least one method through the mock to prove the provider
    // is wired to the mock DRIZZLE (not constructed with a null db).
    const pools = await (svc as DrizzleObservabilityService).getPoolDepths();
    expect(pools).toEqual([]);
    expect(db.execute).toHaveBeenCalledTimes(1);

    await moduleRef.close();
  });
});

// ─── Test fixtures ────────────────────────────────────────────────────────

function makeSyncRun(
  overrides: Partial<Parameters<MemoryObservabilityService['seedSyncRuns']>[0][number]>,
): Parameters<MemoryObservabilityService['seedSyncRuns']>[0][number] {
  return {
    id: 'run-x',
    subscriptionId: 'sub-x',
    integrationId: 'i-x',
    adapter: 'salesforce',
    domain: 'opportunity',
    direction: 'inbound',
    action: 'poll',
    status: 'success',
    recordsFound: 0,
    recordsProcessed: 0,
    durationMs: null,
    error: null,
    startedAt: new Date(),
    completedAt: null,
    ...overrides,
  };
}

function makeFailedJob(
  overrides: Partial<Parameters<MemoryObservabilityService['seedFailedJobs']>[0][number]>,
): Parameters<MemoryObservabilityService['seedFailedJobs']>[0][number] {
  return {
    id: 'j-x',
    jobType: 'job.t',
    pool: 'default',
    status: 'failed',
    error: null,
    startedAt: null,
    finishedAt: new Date(),
    attempts: 1,
    ...overrides,
  };
}
