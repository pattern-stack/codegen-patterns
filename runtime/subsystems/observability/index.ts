/**
 * Observability subsystem public API (ADR-008, 5th subsystem).
 *
 * Import token + protocol in services/controllers:
 * ```typescript
 * import { OBSERVABILITY, type IObservabilityService } from '@pattern-stack/codegen/runtime/subsystems/observability';
 * ```
 *
 * Import the module in AppModule:
 * ```typescript
 * import { ObservabilityModule } from '@pattern-stack/codegen/runtime/subsystems/observability';
 * ObservabilityModule.forRoot({ backend: 'drizzle', reporters: { bridgeMetrics: true } })
 * ```
 */
export { OBSERVABILITY, OBSERVABILITY_REPORTERS } from './observability.tokens';
export type {
  CursorSnapshot,
  IObservabilityService,
  JobRunFailure,
  PoolDepth,
  StatusHistogram,
  SyncRunSummary,
} from './observability.protocol';
export {
  ObservabilityModule,
  type ObservabilityModuleOptions,
  type ObservabilityReporterOptions,
} from './observability.module';
export { DrizzleObservabilityService } from './observability.drizzle-backend';
export { MemoryObservabilityService } from './observability.memory-backend';
export {
  BridgeMetricsReporter,
  type BridgeMetricsRow,
  type BridgeMetricsTick,
} from './reporters/bridge-metrics.reporter';
