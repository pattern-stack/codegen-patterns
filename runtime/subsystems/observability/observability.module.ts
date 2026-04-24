/**
 * ObservabilityModule — DynamicModule factory for the observability
 * subsystem (ADR-008, 5th subsystem).
 *
 * Usage in AppModule:
 * ```typescript
 * ObservabilityModule.forRoot({
 *   backend: 'drizzle',
 *   reporters: { bridgeMetrics: true }, // optional — requires bridge subsystem
 * })
 * ```
 *
 * Usage in tests:
 * ```typescript
 * ObservabilityModule.forRoot({ backend: 'memory' })
 * ```
 *
 * `global: true` means any module that needs `IObservabilityService` can
 * inject `OBSERVABILITY` without importing this module. Register once in
 * AppModule.
 *
 * The drizzle backend requires `DRIZZLE` to be provided globally (e.g.,
 * via DatabaseModule). The memory backend has no dependencies.
 *
 * # Reporters
 *
 * Reporters are orthogonal to backends — they compose on top of either
 * drizzle or memory. The `reporters.bridgeMetrics` flag enables the
 * `BridgeMetricsReporter` sampler. Gated because the reporter imports the
 * bridge + events schemas; consumers without the bridge subsystem should
 * leave it off (the default).
 *
 * `ScheduleModule.forRoot()` is imported conditionally — only when a
 * reporter that needs it is enabled. Keeps the module dependency-light
 * for consumers that only want the read surface.
 */
import { type DynamicModule, Module } from '@nestjs/common';

import { DrizzleObservabilityService } from './observability.drizzle-backend';
import { MemoryObservabilityService } from './observability.memory-backend';
import {
  OBSERVABILITY,
  OBSERVABILITY_REPORTERS,
} from './observability.tokens';

export interface ObservabilityReporterOptions {
  /**
   * Register `BridgeMetricsReporter` — periodic log sampler over
   * `bridge_delivery`. Requires the bridge subsystem (schemas imported
   * transitively). Defaults to `false`.
   */
  bridgeMetrics?: boolean;
}

export interface ObservabilityModuleOptions {
  backend: 'drizzle' | 'memory';
  reporters?: ObservabilityReporterOptions;
}

@Module({})
export class ObservabilityModule {
  static forRoot(
    options: ObservabilityModuleOptions = { backend: 'drizzle' },
  ): DynamicModule {
    const ConcreteClass =
      options.backend === 'drizzle'
        ? DrizzleObservabilityService
        : MemoryObservabilityService;

    const wantsBridgeMetrics = options.reporters?.bridgeMetrics === true;

    const providers: DynamicModule['providers'] = [
      // Register the concrete class as the canonical instance.
      ConcreteClass,
      // OBSERVABILITY token points at the same instance — no duplicate.
      { provide: OBSERVABILITY, useExisting: ConcreteClass },
      // Expose the resolved reporter config for introspection / tests.
      {
        provide: OBSERVABILITY_REPORTERS,
        useValue: options.reporters ?? {},
      },
    ];

    const exports: DynamicModule['exports'] = [OBSERVABILITY];
    if (wantsBridgeMetrics) {
      // Lazy-require keeps the reporter file (and its @nestjs/schedule +
      // bridge schema imports) off the hot path for consumers who don't
      // enable the reporter.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { BridgeMetricsReporter } = require('./reporters/bridge-metrics.reporter');
      providers.push(BridgeMetricsReporter);
      exports.push(BridgeMetricsReporter);
    }

    // ScheduleModule is a PEER dep (optional) — only resolved when a
    // reporter that uses it is enabled. Consumers using the read-only
    // surface (default) are free of the @nestjs/schedule install tax.
    const imports: DynamicModule['imports'] = [];
    if (wantsBridgeMetrics) {
      // Lazy-require: avoids parse-time failure for consumers that haven't
      // installed @nestjs/schedule and don't need reporters.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ScheduleModule } = require('@nestjs/schedule');
      imports.push(ScheduleModule.forRoot());
    }

    return {
      module: ObservabilityModule,
      global: true,
      imports,
      providers,
      exports,
    };
  }
}
