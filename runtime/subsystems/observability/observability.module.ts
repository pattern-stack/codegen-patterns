/**
 * ObservabilityModule — combiner subsystem (ADR-025, OBS-5, OBS-6).
 *
 * Composes the jobs, bridge, and integration read ports into a single
 * `IObservability` facade. Owned by no sibling subsystem; it consumes
 * their tokens via DI, which the consumer app wires by registering the
 * sibling modules in the right order (like BridgeModule — the named
 * precedent in ADR-025).
 *
 * Consumer wiring (register AFTER the composed sibling modules):
 * ```ts
 * @Module({
 *   imports: [
 *     EventsModule.forRoot({ backend: 'drizzle' }),
 *     JobsDomainModule.forRoot({ backend: 'drizzle' }),
 *     BridgeModule.forRoot({ backend: 'drizzle' }),
 *     IntegrationModule.forRoot({ backend: 'drizzle' }),
 *     ObservabilityModule.forRoot({
 *       reporters: {
 *         bridgeMetrics: {
 *           enabled: true,
 *           intervalMs: 60_000,
 *           windowHours: 1,
 *         },
 *       },
 *     }),
 *   ],
 * })
 * class AppModule {}
 * ```
 *
 * # No `backend` option — intentional
 *
 * Unlike ADR-008 infrastructure subsystems (events / jobs / cache /
 * storage), observability is a combiner per ADR-025 and owns no durable
 * state. The "backend" is whichever backends the composed subsystems are
 * running — portability is inherited, not declared. See ADR-025 §4 (when
 * to pick combiner vs. infrastructure) and
 * `.claude/skills/observability/SKILL.md` §1.
 *
 * # Graceful sibling absence
 *
 * The consumed sibling tokens are `@Optional()` inside
 * `ObservabilityService`. An app that only installed a subset of the
 * composed subsystems can still register `ObservabilityModule`; the
 * methods whose sibling is missing return empty shapes.
 *
 * # Reporters (OBS-6)
 *
 * Internal consumers of the `OBSERVABILITY` facade — auto-registered
 * when the matching `reporters.*` key is present and enabled. Reporters
 * are NOT added to `exports`; they are a module-internal concern.
 * Consumers configure them via options; they never import the reporter
 * classes directly.
 */
import { Module, type DynamicModule, type Provider } from '@nestjs/common';

import {
  OBSERVABILITY,
  OBSERVABILITY_MODULE_OPTIONS,
} from './observability.tokens';
import { ObservabilityService } from './observability.service';
import { BridgeMetricsReporter } from './reporters/bridge-metrics.reporter';

/**
 * Config for the bridge-delivery sampler (OBS-6). All fields are required
 * when `enabled: true` — the config is declarative and explicit; there
 * are no hidden defaults. Lives on the module (not the reporter file) so
 * the module's options type stays the single authoritative schema for
 * everything `forRoot` accepts.
 */
export interface BridgeMetricsReporterConfig {
  /** Master switch. Reporter is only registered as a provider when this
   *  is `true` (see `forRoot`). */
  enabled: boolean;
  /** Sampling period in ms. Must be `> 0` when `enabled: true`. */
  intervalMs: number;
  /** Trailing window (hours) passed to `getBridgeDeliveryHistogram`.
   *  Must be `> 0` when `enabled: true`. */
  windowHours: number;
  /** Forwarded verbatim to `IObservability.getBridgeDeliveryHistogram`.
   *   - `undefined` — sibling default semantics
   *   - `null`      — explicit cross-tenant match
   *   - `string`    — filter to that single tenant */
  tenantId?: string | null;
}

/**
 * Named-map of reporter configs. Named, not array, so consumers can toggle
 * individual reporters by key without juggling order and so future reporters
 * can be added without breaking existing configs.
 */
export interface ObservabilityReportersOptions {
  bridgeMetrics?: BridgeMetricsReporterConfig;
}

/**
 * Options for `ObservabilityModule.forRoot()`. Currently only `reporters`;
 * room to grow (sampling, exporters) without changing the module signature.
 */
export interface ObservabilityModuleOptions {
  reporters?: ObservabilityReportersOptions;
}

@Module({})
export class ObservabilityModule {
  static forRoot(options: ObservabilityModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      // Expose the resolved options so internal reporters can read their
      // own config via `OBSERVABILITY_MODULE_OPTIONS`.
      { provide: OBSERVABILITY_MODULE_OPTIONS, useValue: options },
      // Register the concrete class as the canonical instance.
      ObservabilityService,
      // OBSERVABILITY token points at the same instance — consumers inject
      // the token, not the class, per ADR-025 §Shape (index.ts does NOT
      // export `ObservabilityService`).
      { provide: OBSERVABILITY, useExisting: ObservabilityService },
    ];

    // Reporters: auto-registered when enabled, not added to `exports`.
    // They are internal consumers of OBSERVABILITY; consumers configure
    // them via options rather than importing the classes.
    if (options.reporters?.bridgeMetrics?.enabled === true) {
      providers.push(BridgeMetricsReporter);
    }

    return {
      module: ObservabilityModule,
      global: true,
      providers,
      exports: [OBSERVABILITY, OBSERVABILITY_MODULE_OPTIONS],
    };
  }
}
