/**
 * SyncModule — `DynamicModule.forRoot({ backend, multiTenant? })` factory
 * wiring the sync subsystem's substrate (SYNC-6, ADR-008 subsystem pattern).
 *
 * ## What this module provides
 *
 *   - `SYNC_CURSOR_STORE`    — Drizzle or Memory cursor store
 *   - `SYNC_RUN_RECORDER`    — Drizzle or Memory run recorder
 *   - `SYNC_FIELD_DIFFER`    — default `DeepEqualDiffer`
 *   - `SYNC_MULTI_TENANT`    — resolved boolean flag (defaults to false)
 *   - `SYNC_MODULE_OPTIONS`  — the options object itself, for backends
 *     that need to inspect config at construction time
 *
 * ## What this module does NOT provide
 *
 *   - `SYNC_CHANGE_SOURCE` — per-provider per-entity; consumer binds in
 *     their feature module (e.g. `OpportunitySyncModule` provides a
 *     `SalesforceOpportunityChangeSource`).
 *   - `SYNC_SINK` — per canonical entity; consumer binds in their feature
 *     module.
 *   - `SYNC_LOOPBACK_FINGERPRINT_STORE` — optional; consumer provides
 *     only when they have outbound writeback paths. `@Optional()` at the
 *     orchestrator seam means absence is fine.
 *   - `ExecuteSyncUseCase` — registered by the feature module alongside
 *     its source + sink bindings. Providing the orchestrator here would
 *     force Nest to resolve SYNC_CHANGE_SOURCE + SYNC_SINK at module
 *     compile time, which fails when the feature module hasn't been
 *     imported yet. Consumers register `ExecuteSyncUseCase` in the same
 *     `providers` array as their source + sink so resolution is local
 *     to where all three are bound.
 *
 * Same shape as `EventsModule.forRoot` — the module wires the bus; you
 * bring your own handlers. Here: the module wires the substrate; you
 * bring your own source + sink.
 *
 * ## Usage
 *
 * ```ts
 * // AppModule — single source of truth for backend + multi-tenancy.
 * @Module({
 *   imports: [SyncModule.forRoot({ backend: 'drizzle' })],
 * })
 * export class AppModule {}
 *
 * // Per-entity feature module — binds source + sink, gets the
 * // orchestrator for free.
 * @Module({
 *   providers: [
 *     { provide: SYNC_CHANGE_SOURCE, useClass: SalesforceOpportunitySource },
 *     { provide: SYNC_SINK,          useClass: OpportunitySyncSink },
 *     ExecuteSyncUseCase,
 *   ],
 * })
 * export class OpportunitySyncModule {
 *   constructor(
 *     private readonly execute: ExecuteSyncUseCase<CanonicalOpportunity>,
 *   ) {}
 * }
 * ```
 *
 * `global: true` means feature modules do not need to re-import
 * `SyncModule` — the substrate tokens are available project-wide.
 */
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import {
  SYNC_CURSOR_STORE,
  SYNC_FIELD_DIFFER,
  SYNC_MODULE_OPTIONS,
  SYNC_MULTI_TENANT,
  SYNC_RUN_RECORDER,
} from './sync.tokens';
import { MemoryCursorStore } from './sync-cursor-store.memory-backend';
import { MemoryRunRecorder } from './sync-run-recorder.memory-backend';
import { PostgresCursorStore } from './sync-cursor-store.drizzle-backend';
import { DrizzleSyncRunRecorder } from './sync-run-recorder.drizzle-backend';
import { DeepEqualDiffer } from './deep-equal.differ';

export interface SyncModuleOptions {
  /**
   * Backend selection. `drizzle` wires the Postgres cursor store +
   * run-log recorder; `memory` wires in-memory doubles suitable for
   * tests + local dev.
   */
  backend: 'drizzle' | 'memory';

  /**
   * Multi-tenancy opt-in (SYNC-6).
   *
   * When `true`, every call to the orchestrator + both Drizzle backends
   * must supply a non-null `tenantId`; missing values throw
   * `MissingTenantIdError`. Defense-in-depth: the orchestrator rejects
   * at entry (no dangling `status=running` rows) AND the Drizzle
   * backends reject at their write boundary (belt-and-braces for any
   * path that bypasses the orchestrator). Both sites use the shared
   * `assertTenantId` helper so error messages match.
   *
   * Memory backends accept `tenantId` unconditionally — their state is
   * process-local; cross-tenant isolation there is not meaningful.
   *
   * Defaults to `false`.
   */
  multiTenant?: boolean;
}

@Module({})
export class SyncModule {
  static forRoot(options: SyncModuleOptions): DynamicModule {
    const multiTenant = options.multiTenant ?? false;

    const sharedProviders: Provider[] = [
      { provide: SYNC_MODULE_OPTIONS, useValue: options },
      { provide: SYNC_MULTI_TENANT, useValue: multiTenant },
      // Default differ — consumers can override by binding a different
      // `IFieldDiffer<T>` to `SYNC_FIELD_DIFFER` in their feature module.
      { provide: SYNC_FIELD_DIFFER, useValue: new DeepEqualDiffer() },
    ];

    const backendProviders: Provider[] =
      options.backend === 'memory'
        ? [
            // Wired as singletons via `useValue` so tests can pull
            // them out via `moduleRef.get(MemoryCursorStore)` for
            // direct assertions. Matches JOB-4 / MemoryJobStore shape.
            { provide: MemoryCursorStore, useValue: new MemoryCursorStore() },
            {
              provide: SYNC_CURSOR_STORE,
              useExisting: MemoryCursorStore,
            },
            { provide: MemoryRunRecorder, useValue: new MemoryRunRecorder() },
            {
              provide: SYNC_RUN_RECORDER,
              useExisting: MemoryRunRecorder,
            },
          ]
        : [
            // Drizzle backends — injected with DRIZZLE (provided by the
            // consumer's DrizzleModule) + the SYNC_MULTI_TENANT flag
            // we bound above.
            { provide: SYNC_CURSOR_STORE, useClass: PostgresCursorStore },
            { provide: SYNC_RUN_RECORDER, useClass: DrizzleSyncRunRecorder },
          ];

    return {
      module: SyncModule,
      global: true,
      providers: [...sharedProviders, ...backendProviders],
      exports: [
        SYNC_MODULE_OPTIONS,
        SYNC_MULTI_TENANT,
        SYNC_FIELD_DIFFER,
        SYNC_CURSOR_STORE,
        SYNC_RUN_RECORDER,
      ],
    };
  }
}
