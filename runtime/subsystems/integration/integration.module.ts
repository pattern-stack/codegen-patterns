/**
 * IntegrationModule — `DynamicModule.forRoot({ backend, multiTenant? })` factory
 * wiring the integration subsystem's substrate (SYNC-6, ADR-008 subsystem pattern).
 *
 * ## What this module provides
 *
 *   - `INTEGRATION_CURSOR_STORE`    — Drizzle or Memory cursor store
 *   - `INTEGRATION_RUN_RECORDER`    — Drizzle or Memory run recorder
 *   - `INTEGRATION_FIELD_DIFFER`    — default `DeepEqualDiffer`
 *   - `INTEGRATION_MULTI_TENANT`    — resolved boolean flag (defaults to false)
 *   - `INTEGRATION_MODULE_OPTIONS`  — the options object itself, for backends
 *     that need to inspect config at construction time
 *
 * ## What this module does NOT provide
 *
 *   - `INTEGRATION_CHANGE_SOURCE` — per-provider per-entity; consumer binds in
 *     their feature module (e.g. `OpportunityIntegrationModule` provides a
 *     `SalesforceOpportunityChangeSource`). Loopback suppression — when
 *     needed — is composed into the primitive's middleware chain via
 *     `createLoopbackMiddleware(store)` (#226-5 / ADR-033); the
 *     orchestrator no longer accepts a fingerprint store directly.
 *   - `INTEGRATION_SINK` — per canonical entity; consumer binds in their feature
 *     module.
 *   - `ExecuteIntegrationUseCase` — registered by the feature module alongside
 *     its source + sink bindings. Providing the orchestrator here would
 *     force Nest to resolve INTEGRATION_CHANGE_SOURCE + INTEGRATION_SINK at module
 *     compile time, which fails when the feature module hasn't been
 *     imported yet. Consumers register `ExecuteIntegrationUseCase` in the same
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
 *   imports: [IntegrationModule.forRoot({ backend: 'drizzle' })],
 * })
 * export class AppModule {}
 *
 * // Per-entity feature module — binds source + sink, gets the
 * // orchestrator for free.
 * @Module({
 *   providers: [
 *     { provide: INTEGRATION_CHANGE_SOURCE, useClass: SalesforceOpportunitySource },
 *     { provide: INTEGRATION_SINK,          useClass: OpportunityIntegrationSink },
 *     ExecuteIntegrationUseCase,
 *   ],
 * })
 * export class OpportunityIntegrationModule {
 *   constructor(
 *     private readonly execute: ExecuteIntegrationUseCase<CanonicalOpportunity>,
 *   ) {}
 * }
 * ```
 *
 * `global: true` means feature modules do not need to re-import
 * `IntegrationModule` — the substrate tokens are available project-wide.
 */
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import {
  INTEGRATION_CURSOR_STORE,
  INTEGRATION_FIELD_DIFFER,
  INTEGRATION_MODULE_OPTIONS,
  INTEGRATION_MULTI_TENANT,
  INTEGRATION_RUN_RECORDER,
} from './integration.tokens';
import { MemoryCursorStore } from './integration-cursor-store.memory-backend';
import { MemoryRunRecorder } from './integration-run-recorder.memory-backend';
import { PostgresCursorStore } from './integration-cursor-store.drizzle-backend';
import { DrizzleIntegrationRunRecorder } from './integration-run-recorder.drizzle-backend';
import { DeepEqualDiffer } from './deep-equal.differ';

export interface IntegrationModuleOptions {
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
export class IntegrationModule {
  static forRoot(options: IntegrationModuleOptions): DynamicModule {
    const multiTenant = options.multiTenant ?? false;

    const sharedProviders: Provider[] = [
      { provide: INTEGRATION_MODULE_OPTIONS, useValue: options },
      { provide: INTEGRATION_MULTI_TENANT, useValue: multiTenant },
      // Default differ — consumers can override by binding a different
      // `IFieldDiffer<T>` to `INTEGRATION_FIELD_DIFFER` in their feature module.
      { provide: INTEGRATION_FIELD_DIFFER, useValue: new DeepEqualDiffer() },
    ];

    const backendProviders: Provider[] =
      options.backend === 'memory'
        ? [
            // Wired as singletons via `useValue` so tests can pull
            // them out via `moduleRef.get(MemoryCursorStore)` for
            // direct assertions. Matches JOB-4 / MemoryJobStore shape.
            { provide: MemoryCursorStore, useValue: new MemoryCursorStore() },
            {
              provide: INTEGRATION_CURSOR_STORE,
              useExisting: MemoryCursorStore,
            },
            { provide: MemoryRunRecorder, useValue: new MemoryRunRecorder() },
            {
              provide: INTEGRATION_RUN_RECORDER,
              useExisting: MemoryRunRecorder,
            },
          ]
        : [
            // Drizzle backends — injected with DRIZZLE (provided by the
            // consumer's DrizzleModule) + the INTEGRATION_MULTI_TENANT flag
            // we bound above.
            { provide: INTEGRATION_CURSOR_STORE, useClass: PostgresCursorStore },
            { provide: INTEGRATION_RUN_RECORDER, useClass: DrizzleIntegrationRunRecorder },
          ];

    return {
      module: IntegrationModule,
      global: true,
      providers: [...sharedProviders, ...backendProviders],
      exports: [
        INTEGRATION_MODULE_OPTIONS,
        INTEGRATION_MULTI_TENANT,
        INTEGRATION_FIELD_DIFFER,
        INTEGRATION_CURSOR_STORE,
        INTEGRATION_RUN_RECORDER,
      ],
    };
  }
}
