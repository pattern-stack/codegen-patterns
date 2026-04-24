/**
 * ObservabilityModule — combiner subsystem (ADR-025, OBS-5).
 *
 * Composes the jobs, bridge, and sync read ports into a single
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
 *     SyncModule.forRoot({ backend: 'drizzle' }),
 *     ObservabilityModule.forRoot(),
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
 */
import { Module, type DynamicModule, type Provider } from '@nestjs/common';

import {
  OBSERVABILITY,
  OBSERVABILITY_MODULE_OPTIONS,
} from './observability.tokens';
import { ObservabilityService } from './observability.service';

/**
 * Options for `ObservabilityModule.forRoot()`. Empty in phase 1.
 *
 * Reserved for phase 2 — OBS-6 extends this shape with a `reporters`
 * field (internal `OnModuleInit` + `setInterval` consumers that inject
 * `OBSERVABILITY` and emit logs / metrics). Leaving the type exported
 * (and registered via `OBSERVABILITY_MODULE_OPTIONS`) today lets OBS-6
 * add fields without changing the module signature.
 *
 * eslint-disable-next-line @typescript-eslint/no-empty-object-type
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ObservabilityModuleOptions {}

@Module({})
export class ObservabilityModule {
  static forRoot(options: ObservabilityModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      // Expose the resolved options for introspection / phase-2 reporters.
      { provide: OBSERVABILITY_MODULE_OPTIONS, useValue: options },
      // Register the concrete class as the canonical instance.
      ObservabilityService,
      // OBSERVABILITY token points at the same instance — consumers inject
      // the token, not the class, per ADR-025 §Shape (index.ts does NOT
      // export `ObservabilityService`).
      { provide: OBSERVABILITY, useExisting: ObservabilityService },
    ];

    return {
      module: ObservabilityModule,
      global: true,
      providers,
      exports: [OBSERVABILITY, OBSERVABILITY_MODULE_OPTIONS],
    };
  }
}
