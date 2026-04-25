/**
 * SyncModule unit tests (SYNC-6).
 *
 * Mirrors `events-module.spec.ts`: compile the module via
 * `@nestjs/testing`, assert the tokens resolve to the expected backends,
 * and exercise the multi-tenancy surface end-to-end.
 *
 * Memory-backend path is the primary test surface; the Drizzle path is
 * exercised with a fake DRIZZLE binding so we can assert the providers
 * bind correctly without Postgres. Real Drizzle wiring is validated by
 * the backend specs (#151) and the eventual integration tests.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'bun:test';
import { Test } from '@nestjs/testing';
import { Global, Module } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { DRIZZLE } from '../../../../runtime/constants/tokens';
import type { DrizzleClient } from '../../../../runtime/types/drizzle';
import { SyncModule } from '../../../../runtime/subsystems/sync/sync.module';
import {
  SYNC_CHANGE_SOURCE,
  SYNC_CURSOR_STORE,
  SYNC_FIELD_DIFFER,
  SYNC_MODULE_OPTIONS,
  SYNC_MULTI_TENANT,
  SYNC_RUN_RECORDER,
  SYNC_SINK,
} from '../../../../runtime/subsystems/sync/sync.tokens';
import { MemoryCursorStore } from '../../../../runtime/subsystems/sync/sync-cursor-store.memory-backend';
import { MemoryRunRecorder } from '../../../../runtime/subsystems/sync/sync-run-recorder.memory-backend';
import { PostgresCursorStore } from '../../../../runtime/subsystems/sync/sync-cursor-store.drizzle-backend';
import { DrizzleSyncRunRecorder } from '../../../../runtime/subsystems/sync/sync-run-recorder.drizzle-backend';
import { DeepEqualDiffer } from '../../../../runtime/subsystems/sync/deep-equal.differ';
import { ExecuteSyncUseCase } from '../../../../runtime/subsystems/sync/execute-sync.use-case';
import { MissingTenantIdError } from '../../../../runtime/subsystems/sync/sync-errors';
import type {
  Change,
  IChangeSource,
  SyncSubscriptionView,
} from '../../../../runtime/subsystems/sync/sync-change-source.protocol';
import type { ISyncSink } from '../../../../runtime/subsystems/sync/sync-sink.protocol';

// ─── Inline fakes for source + sink (feature-module-owned tokens) ───────────

interface CanonicalOpp extends Record<string, unknown> {
  external_id: string;
  amount?: number;
}

class EmptySource implements IChangeSource<CanonicalOpp> {
  readonly label = 'test';
  // eslint-disable-next-line @typescript-eslint/require-yield
  async *listChanges(
    _sub: SyncSubscriptionView,
    _cursor: unknown | null,
  ): AsyncIterable<Change<CanonicalOpp>> {
    // yields nothing
    return;
  }
}

class OneChangeSource implements IChangeSource<CanonicalOpp> {
  readonly label = 'test';
  async *listChanges(
    _sub: SyncSubscriptionView,
    _cursor: unknown | null,
  ): AsyncIterable<Change<CanonicalOpp>> {
    yield {
      externalId: 'ext-1',
      operation: 'created',
      record: { external_id: 'ext-1', amount: 100 },
      cursor: { v: 1 },
      source: 'poll',
    };
  }
}

class NoopSink implements ISyncSink<CanonicalOpp> {
  async findByExternalId(): Promise<CanonicalOpp | null> {
    return null;
  }
  async upsertByExternalId(
    _userId: string,
    record: CanonicalOpp,
  ): Promise<{ id: string; saved: CanonicalOpp }> {
    return { id: `local-${record.external_id}`, saved: record };
  }
  async softDeleteByExternalId(): Promise<{ id: string } | null> {
    return null;
  }
}

/**
 * Feature-module wrapper so tests can compose `SyncModule.forRoot(...)`
 * with a consumer-provided source + sink in a single `Test.createTestingModule`
 * call. This mirrors what a real consumer's `OpportunitySyncModule` looks like.
 */
@Module({
  providers: [
    { provide: SYNC_CHANGE_SOURCE, useClass: OneChangeSource },
    { provide: SYNC_SINK, useClass: NoopSink },
    ExecuteSyncUseCase,
  ],
})
class TestFeatureModule {}

@Module({
  providers: [
    { provide: SYNC_CHANGE_SOURCE, useClass: EmptySource },
    { provide: SYNC_SINK, useClass: NoopSink },
    ExecuteSyncUseCase,
  ],
})
class EmptyFeatureModule {}

// ─── Memory backend ─────────────────────────────────────────────────────────

describe('SyncModule.forRoot({ backend: "memory" })', () => {
  it('resolves SYNC_CURSOR_STORE to MemoryCursorStore', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SyncModule.forRoot({ backend: 'memory' })],
    }).compile();

    expect(moduleRef.get(SYNC_CURSOR_STORE)).toBeInstanceOf(MemoryCursorStore);
    await moduleRef.close();
  });

  it('resolves SYNC_RUN_RECORDER to MemoryRunRecorder', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SyncModule.forRoot({ backend: 'memory' })],
    }).compile();

    expect(moduleRef.get(SYNC_RUN_RECORDER)).toBeInstanceOf(MemoryRunRecorder);
    await moduleRef.close();
  });

  it('resolves SYNC_FIELD_DIFFER to DeepEqualDiffer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SyncModule.forRoot({ backend: 'memory' })],
    }).compile();

    expect(moduleRef.get(SYNC_FIELD_DIFFER)).toBeInstanceOf(DeepEqualDiffer);
    await moduleRef.close();
  });

  it('binds SYNC_MODULE_OPTIONS to the passed options', async () => {
    const options = { backend: 'memory' as const, multiTenant: true };
    const moduleRef = await Test.createTestingModule({
      imports: [SyncModule.forRoot(options)],
    }).compile();

    expect(moduleRef.get(SYNC_MODULE_OPTIONS)).toEqual(options);
    await moduleRef.close();
  });

  it('defaults SYNC_MULTI_TENANT to false when multiTenant is omitted', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SyncModule.forRoot({ backend: 'memory' })],
    }).compile();

    expect(moduleRef.get(SYNC_MULTI_TENANT)).toBe(false);
    await moduleRef.close();
  });

  it('resolves ExecuteSyncUseCase when a feature module binds source + sink', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SyncModule.forRoot({ backend: 'memory' }),
        EmptyFeatureModule,
      ],
    }).compile();

    const orch = moduleRef.get(ExecuteSyncUseCase);
    expect(orch).toBeInstanceOf(ExecuteSyncUseCase);
    await moduleRef.close();
  });

  it('MemoryCursorStore and MemoryRunRecorder are singletons (same instance via class + token)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SyncModule.forRoot({ backend: 'memory' })],
    }).compile();

    expect(moduleRef.get(SYNC_CURSOR_STORE)).toBe(moduleRef.get(MemoryCursorStore));
    expect(moduleRef.get(SYNC_RUN_RECORDER)).toBe(moduleRef.get(MemoryRunRecorder));
    await moduleRef.close();
  });
});

// ─── End-to-end memory run ──────────────────────────────────────────────────

describe('SyncModule end-to-end (memory backend)', () => {
  it('executes a run through the composed module with no tenantId (single-tenant)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SyncModule.forRoot({ backend: 'memory' }),
        TestFeatureModule,
      ],
    }).compile();

    const orch = moduleRef.get(ExecuteSyncUseCase);
    const recorder = moduleRef.get(MemoryRunRecorder);

    const result = await orch.execute({
      subscription: { id: 'sub-1', domain: 'opportunity' },
      userId: 'user-1',
      provider: 'salesforce-crm',
      direction: 'inbound',
      action: 'poll',
    });

    expect(result.status).toBe('success');
    expect(result.recordsProcessed).toBe(1);

    // MemoryRunRecorder captured the lifecycle — test ergonomics helpers
    // make this a one-liner.
    const runs = recorder.getRunsForSubscription('sub-1');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('success');
    expect(recorder.getItemsForRun(runs[0]!.id)).toHaveLength(1);

    await moduleRef.close();
  });
});

// ─── Multi-tenancy enforcement ──────────────────────────────────────────────

describe('SyncModule.forRoot({ multiTenant: true }) — enforcement', () => {
  it('binds SYNC_MULTI_TENANT to true', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SyncModule.forRoot({ backend: 'memory', multiTenant: true })],
    }).compile();

    expect(moduleRef.get(SYNC_MULTI_TENANT)).toBe(true);
    await moduleRef.close();
  });

  it('orchestrator rejects execute() with no tenantId', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SyncModule.forRoot({ backend: 'memory', multiTenant: true }),
        TestFeatureModule,
      ],
    }).compile();

    const orch = moduleRef.get(ExecuteSyncUseCase);
    const recorder = moduleRef.get(MemoryRunRecorder);

    await expect(
      orch.execute({
        subscription: { id: 'sub-1', domain: 'opportunity' },
        userId: 'user-1',
        provider: 'salesforce-crm',
        direction: 'inbound',
        action: 'poll',
      }),
    ).rejects.toBeInstanceOf(MissingTenantIdError);

    // Critical: no dangling `status=running` row. The orchestrator
    // threw BEFORE startRun fired.
    expect(recorder.runs.size).toBe(0);

    await moduleRef.close();
  });

  it('orchestrator rejects execute() with explicit null tenantId', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SyncModule.forRoot({ backend: 'memory', multiTenant: true }),
        TestFeatureModule,
      ],
    }).compile();

    const orch = moduleRef.get(ExecuteSyncUseCase);
    const recorder = moduleRef.get(MemoryRunRecorder);

    await expect(
      orch.execute({
        subscription: { id: 'sub-1', domain: 'opportunity' },
        userId: 'user-1',
        provider: 'salesforce-crm',
        direction: 'inbound',
        action: 'poll',
        tenantId: null,
      }),
    ).rejects.toBeInstanceOf(MissingTenantIdError);
    expect(recorder.runs.size).toBe(0);

    await moduleRef.close();
  });

  it('accepts a tenantId and passes it through the full run', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SyncModule.forRoot({ backend: 'memory', multiTenant: true }),
        TestFeatureModule,
      ],
    }).compile();

    const orch = moduleRef.get(ExecuteSyncUseCase);
    const recorder = moduleRef.get(MemoryRunRecorder);

    const result = await orch.execute({
      subscription: { id: 'sub-1', domain: 'opportunity' },
      userId: 'user-1',
      provider: 'salesforce-crm',
      direction: 'inbound',
      action: 'poll',
      tenantId: 'tenant-a',
    });

    expect(result.status).toBe('success');
    const runs = recorder.getRunsForSubscription('sub-1');
    expect(runs[0]?.tenantId).toBe('tenant-a');
    const items = recorder.getItemsForRun(runs[0]!.id);
    expect(items[0]?.tenantId).toBe('tenant-a');

    await moduleRef.close();
  });
});

// ─── Drizzle backend wiring ─────────────────────────────────────────────────

describe('SyncModule.forRoot({ backend: "drizzle" })', () => {
  /**
   * Consumers normally import DrizzleModule which binds the DRIZZLE token;
   * in tests we provide it directly via a fake pg-proxy client. This lets
   * us assert SyncModule wires the Drizzle backend classes without
   * needing Postgres.
   */
  @Global()
  @Module({
    providers: [
      {
        provide: DRIZZLE,
        useValue: drizzle(async () => ({ rows: [] })) as unknown as DrizzleClient,
      },
    ],
    exports: [DRIZZLE],
  })
  class FakeDrizzleModule {}

  it('resolves SYNC_CURSOR_STORE to PostgresCursorStore', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeDrizzleModule, SyncModule.forRoot({ backend: 'drizzle' })],
    }).compile();

    expect(moduleRef.get(SYNC_CURSOR_STORE)).toBeInstanceOf(PostgresCursorStore);
    await moduleRef.close();
  });

  it('resolves SYNC_RUN_RECORDER to DrizzleSyncRunRecorder', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeDrizzleModule, SyncModule.forRoot({ backend: 'drizzle' })],
    }).compile();

    expect(moduleRef.get(SYNC_RUN_RECORDER)).toBeInstanceOf(DrizzleSyncRunRecorder);
    await moduleRef.close();
  });

  it('threads SYNC_MULTI_TENANT=true into the Drizzle backends', async () => {
    // Exercise the end-to-end path: module flag → backend behavior.
    // The backend throws MissingTenantIdError when flagged on, with no
    // tenantId in the call.
    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDrizzleModule,
        SyncModule.forRoot({ backend: 'drizzle', multiTenant: true }),
      ],
    }).compile();

    const cursors = moduleRef.get<PostgresCursorStore>(SYNC_CURSOR_STORE);

    await expect(cursors.get('sub-1')).rejects.toBeInstanceOf(
      MissingTenantIdError,
    );

    await moduleRef.close();
  });
});
