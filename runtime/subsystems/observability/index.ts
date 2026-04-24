/**
 * Observability combiner subsystem — public API (ADR-025, OBS-5).
 *
 * Re-exports the protocol, composed return types, DI tokens, module, and
 * error base class.
 *
 * Deliberately does NOT export `ObservabilityService` — consumers inject
 * the `OBSERVABILITY` token, not the concrete class. Keeps the combiner's
 * authoring surface one-way (consumers see the port, never the impl) and
 * leaves room to swap the impl in phase 2 without a public-API bump.
 *
 * Usage:
 * ```ts
 * import {
 *   OBSERVABILITY,
 *   ObservabilityModule,
 *   type IObservability,
 * } from '@pattern-stack/codegen/runtime/subsystems/observability';
 *
 * // In AppModule
 * ObservabilityModule.forRoot(),
 *
 * // In a consumer service
 * constructor(@Inject(OBSERVABILITY) private readonly obs: IObservability) {}
 * ```
 */

// Protocol + composed return types (re-exported through the protocol file)
export type {
  IObservability,
  PoolStatusCount,
  JobRunFailure,
  StatusHistogram,
  SyncRunSummary,
  CursorSnapshot,
} from './observability.protocol';

// DI tokens
export {
  OBSERVABILITY,
  OBSERVABILITY_MODULE_OPTIONS,
} from './observability.tokens';

// Module wiring
export {
  ObservabilityModule,
  type ObservabilityModuleOptions,
  type ObservabilityReportersOptions,
  type BridgeMetricsReporterConfig,
} from './observability.module';

// Reporters barrel — re-exported for test and internal reference. Consumers
// do NOT construct these classes directly; they are auto-registered by
// `ObservabilityModule.forRoot()` when enabled via options.
export * from './reporters';

// Errors
export { ObservabilityError } from './observability-errors';
