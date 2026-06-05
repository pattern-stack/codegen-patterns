/**
 * IntegrationModule unit tests (SYNC-6).
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
import { IntegrationModule } from '../../../../runtime/subsystems/integration/integration.module';
import {
  INTEGRATION_CHANGE_SOURCE,
  INTEGRATION_CURSOR_STORE,
  INTEGRATION_FIELD_DIFFER,
  INTEGRATION_MODULE_OPTIONS,
  INTEGRATION_MULTI_TENANT,
  INTEGRATION_RUN_RECORDER,
  INTEGRATION_SINK,
} from '../../../../runtime/subsystems/integration/integration.tokens';
import { MemoryCursorStore } from '../../../../runtime/subsystems/integration/integration-cursor-store.memory-backend';
import { MemoryRunRecorder } from '../../../../runtime/subsystems/integration/integration-run-recorder.memory-backend';
import { PostgresCursorStore } from '../../../../runtime/subsystems/integration/integration-cursor-store.drizzle-backend';
import { DrizzleIntegrationRunRecorder } from '../../../../runtime/subsystems/integration/integration-run-recorder.drizzle-backend';
import { DeepEqualDiffer } from '../../../../runtime/subsystems/integration/deep-equal.differ';
import { ExecuteIntegrationUseCase } from '../../../../runtime/subsystems/integration/execute-integration.use-case';
import { MissingTenantIdError } from '../../../../runtime/subsystems/integration/integration-errors';
import type {
  Change,
  IChangeSource,
  IntegrationSubscriptionView,
} from '../../../../runtime/subsystems/integration/integration-change-source.protocol';
import type { IIntegrationSink } from '../../../../runtime/subsystems/integration/integration-sink.protocol';

// ─── Inline fakes for source + sink (feature-module-owned tokens) ───────────

interface CanonicalOpp extends Record<string, unknown> {
  external_id: string;
  amount?: number;
}

class EmptySource implements IChangeSource<CanonicalOpp> {
  readonly label = 'test';
  // eslint-disable-next-line @typescript-eslint/require-yield
  async *listChanges(
    _sub: IntegrationSubscriptionView,
    _cursor: unknown | null,
  ): AintegrationIterable<Change<CanonicalOpp>> {
    // yields nothing
    return;
  }
}

class OneChangeSource implements IChangeSource<CanonicalOpp> {
  readonly label = 'test';
  async *listChanges(
    _sub: IntegrationSubscriptionView,
    _cursor: unknown | null,
  ): AintegrationIterable<Change<CanonicalOpp>> {
    yield {
      externalId: 'ext-1',
      operation: 'created',
      record: { external_id: 'ext-1', amount: 100 },
      cursor: { v: 1 },
      source: 'poll',
    };
  }
}

class NoopSink implements IIntegrationSink<CanonicalOpp> {
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
 * Feature-module wrapper so tests can compose `IntegrationModule.forRoot(...)`
 * with a consumer-provided source + sink in a single `Test.createTestingModule`
 * call. This mirrors what a real consumer's `OpportunityIntegrationModule` looks like.
 */
@Module({
  providers: [
    { provide: INTEGRATION_CHANGE_SOURCE, useClass: OneChangeSource },
    { provide: INTEGRATION_SINK, useClass: NoopSink },
    ExecuteIntegrationUseCase,
  ],
})
class TestFeatureModule {}

@Module({
  providers: [
    { provide: INTEGRATION_CHANGE_SOURCE, useClass: EmptySource },
    { provide: INTEGRATION_SINK, useClass: NoopSink },
    ExecuteIntegrationUseCase,
  ],
})
class EmptyFeatureModule {}

// ─── Memory backend ─────────────────────────────────────────────────────────

describe('IntegrationModule.forRoot({ backend: "memory" })', () => {
  it('resolves INTEGRATION_CURSOR_STORE to MemoryCursorStore', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IntegrationModule.forRoot({ backend: 'memory' })],
    }).compile();

    expect(moduleRef.get(INTEGRATION_CURSOR_STORE)).toBeInstanceOf(MemoryCursorStore);
    await moduleRef.close();
  });

  it('resolves INTEGRATION_RUN_RECORDER to MemoryRunRecorder', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IntegrationModule.forRoot({ backend: 'memory' })],
    }).compile();

    expect(moduleRef.get(INTEGRATION_RUN_RECORDER)).toBeInstanceOf(MemoryRunRecorder);
    await moduleRef.close();
  });

  it('resolves INTEGRATION_FIELD_DIFFER to DeepEqualDiffer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IntegrationModule.forRoot({ backend: 'memory' })],
    }).compile();

    expect(moduleRef.get(INTEGRATION_FIELD_DIFFER)).toBeInstanceOf(DeepEqualDiffer);
    await moduleRef.close();
  });

  // DIFFER-UNIGNORE (0.17.1): `options.differ` threads into the bound differ.
  it('threads options.differ.unignore into the bound DeepEqualDiffer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot({
          backend: 'memory',
          differ: { unignore: ['deletedAt'] },
        }),
      ],
    }).compile();

    const differ = moduleRef.get(INTEGRATION_FIELD_DIFFER) as DeepEqualDiffer<
      Record<string, unknown>
    >;
    // Behavioural proof: the default differ would 'noop' a deletedAt-only
    // change; the threaded unignore makes it register as a field diff.
    const result = differ.diff(
      { deletedAt: null },
      { deletedAt: '2026-06-04T00:00:00.000Z' },
    );
    expect(result).toEqual({
      deletedAt: { from: null, to: '2026-06-04T00:00:00.000Z' },
    });
    await moduleRef.close();
  });

  it('default differ (no options.differ) keeps deletedAt ignored', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IntegrationModule.forRoot({ backend: 'memory' })],
    }).compile();

    const differ = moduleRef.get(INTEGRATION_FIELD_DIFFER) as DeepEqualDiffer<
      Record<string, unknown>
    >;
    expect(
      differ.diff({ deletedAt: null }, { deletedAt: '2026-06-04T00:00:00.000Z' }),
    ).toBe('noop');
    await moduleRef.close();
  });

  it('binds INTEGRATION_MODULE_OPTIONS to the passed options', async () => {
    const options = { backend: 'memory' as const, multiTenant: true };
    const moduleRef = await Test.createTestingModule({
      imports: [IntegrationModule.forRoot(options)],
    }).compile();

    expect(moduleRef.get(INTEGRATION_MODULE_OPTIONS)).toEqual(options);
    await moduleRef.close();
  });

  it('defaults INTEGRATION_MULTI_TENANT to false when multiTenant is omitted', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IntegrationModule.forRoot({ backend: 'memory' })],
    }).compile();

    expect(moduleRef.get(INTEGRATION_MULTI_TENANT)).toBe(false);
    await moduleRef.close();
  });

  it('resolves ExecuteIntegrationUseCase when a feature module binds source + sink', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot({ backend: 'memory' }),
        EmptyFeatureModule,
      ],
    }).compile();

    const orch = moduleRef.get(ExecuteIntegrationUseCase);
    expect(orch).toBeInstanceOf(ExecuteIntegrationUseCase);
    await moduleRef.close();
  });

  it('MemoryCursorStore and MemoryRunRecorder are singletons (same instance via class + token)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IntegrationModule.forRoot({ backend: 'memory' })],
    }).compile();

    expect(moduleRef.get(INTEGRATION_CURSOR_STORE)).toBe(moduleRef.get(MemoryCursorStore));
    expect(moduleRef.get(INTEGRATION_RUN_RECORDER)).toBe(moduleRef.get(MemoryRunRecorder));
    await moduleRef.close();
  });
});

// ─── End-to-end memory run ──────────────────────────────────────────────────

describe('IntegrationModule end-to-end (memory backend)', () => {
  it('executes a run through the composed module with no tenantId (single-tenant)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot({ backend: 'memory' }),
        TestFeatureModule,
      ],
    }).compile();

    const orch = moduleRef.get(ExecuteIntegrationUseCase);
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

describe('IntegrationModule.forRoot({ multiTenant: true }) — enforcement', () => {
  it('binds INTEGRATION_MULTI_TENANT to true', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IntegrationModule.forRoot({ backend: 'memory', multiTenant: true })],
    }).compile();

    expect(moduleRef.get(INTEGRATION_MULTI_TENANT)).toBe(true);
    await moduleRef.close();
  });

  it('orchestrator rejects execute() with no tenantId', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot({ backend: 'memory', multiTenant: true }),
        TestFeatureModule,
      ],
    }).compile();

    const orch = moduleRef.get(ExecuteIntegrationUseCase);
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
        IntegrationModule.forRoot({ backend: 'memory', multiTenant: true }),
        TestFeatureModule,
      ],
    }).compile();

    const orch = moduleRef.get(ExecuteIntegrationUseCase);
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
        IntegrationModule.forRoot({ backend: 'memory', multiTenant: true }),
        TestFeatureModule,
      ],
    }).compile();

    const orch = moduleRef.get(ExecuteIntegrationUseCase);
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

describe('IntegrationModule.forRoot({ backend: "drizzle" })', () => {
  /**
   * Consumers normally import DrizzleModule which binds the DRIZZLE token;
   * in tests we provide it directly via a fake pg-proxy client. This lets
   * us assert IntegrationModule wires the Drizzle backend classes without
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

  it('resolves INTEGRATION_CURSOR_STORE to PostgresCursorStore', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeDrizzleModule, IntegrationModule.forRoot({ backend: 'drizzle' })],
    }).compile();

    expect(moduleRef.get(INTEGRATION_CURSOR_STORE)).toBeInstanceOf(PostgresCursorStore);
    await moduleRef.close();
  });

  it('resolves INTEGRATION_RUN_RECORDER to DrizzleIntegrationRunRecorder', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeDrizzleModule, IntegrationModule.forRoot({ backend: 'drizzle' })],
    }).compile();

    expect(moduleRef.get(INTEGRATION_RUN_RECORDER)).toBeInstanceOf(DrizzleIntegrationRunRecorder);
    await moduleRef.close();
  });

  it('threads INTEGRATION_MULTI_TENANT=true into the Drizzle backends', async () => {
    // Exercise the end-to-end path: module flag → backend behavior.
    // The backend throws MissingTenantIdError when flagged on, with no
    // tenantId in the call.
    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDrizzleModule,
        IntegrationModule.forRoot({ backend: 'drizzle', multiTenant: true }),
      ],
    }).compile();

    const cursors = moduleRef.get<PostgresCursorStore>(INTEGRATION_CURSOR_STORE);

    await expect(cursors.get('sub-1')).rejects.toBeInstanceOf(
      MissingTenantIdError,
    );

    await moduleRef.close();
  });
});
