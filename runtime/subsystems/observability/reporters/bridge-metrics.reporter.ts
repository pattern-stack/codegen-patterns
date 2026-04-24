/**
 * BridgeMetricsReporter — internal consumer of `IObservability`
 * (ADR-025, OBS-6).
 *
 * Periodically samples `getBridgeDeliveryHistogram` from the observability
 * facade and emits one log line per tick. Auto-registered by
 * `ObservabilityModule.forRoot()` when
 * `options.reporters.bridgeMetrics.enabled === true`. Consumers configure
 * via options; they never import this class. Not exported from the
 * module's `exports` array — internal.
 *
 * # Invariants (enforced by skill + ADR-025)
 *
 *   - Injects ONLY `OBSERVABILITY` + `OBSERVABILITY_MODULE_OPTIONS`. Never
 *     `BRIDGE_DELIVERY_REPO` or any other sibling token. Reporters are
 *     consumers of the composed facade, not parallel composers.
 *   - Never reaches into sibling tables or extends `IObservability`.
 *   - Errors isolated per-tick (logged, never rethrown) so a transient
 *     sibling failure does not kill the interval.
 *   - `tenantId` passes VERBATIM to the facade — observability owns tenant
 *     semantics, reporters don't re-implement them.
 *
 * # Lifecycle
 *
 *   - `onModuleInit` — eager first-tick, then `setInterval`. Handle is
 *     `.unref()`-ed when supported so the loop never blocks node shutdown.
 *   - `onModuleDestroy` — `clearInterval` + null the handle. Idempotent.
 *
 * No `@nestjs/schedule` dependency — raw `setInterval` keeps the runtime
 * footprint minimal and avoids pulling a decorator framework in for a
 * single loop.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import type { IObservability } from '../observability.protocol';
import {
  OBSERVABILITY,
  OBSERVABILITY_MODULE_OPTIONS,
} from '../observability.tokens';
// Type-only imports — the module imports this file as a value for DI
// registration, and this file imports config types back. Keeping the
// back-edge type-only prevents a runtime circular-import.
import type {
  BridgeMetricsReporterConfig,
  ObservabilityModuleOptions,
} from '../observability.module';

@Injectable()
export class BridgeMetricsReporter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BridgeMetricsReporter.name);
  private handle: ReturnType<typeof setInterval> | null = null;
  private readonly config: BridgeMetricsReporterConfig | undefined;

  constructor(
    @Inject(OBSERVABILITY) private readonly observability: IObservability,
    @Inject(OBSERVABILITY_MODULE_OPTIONS) options: ObservabilityModuleOptions,
  ) {
    this.config = options.reporters?.bridgeMetrics;
  }

  onModuleInit(): void {
    if (!this.config || !this.config.enabled) {
      this.logger.log('BridgeMetricsReporter disabled');
      return;
    }
    if (this.config.intervalMs <= 0 || this.config.windowHours <= 0) {
      this.logger.warn(
        `invalid config; not starting: intervalMs=${this.config.intervalMs} windowHours=${this.config.windowHours}`,
      );
      return;
    }
    // Eager first-tick so consumers see data immediately on boot, without
    // waiting `intervalMs` for the first sample.
    void this.runOnce();
    this.handle = setInterval(() => {
      void this.runOnce();
    }, this.config.intervalMs);
    // `.unref()` lets the node process exit even if the interval is still
    // scheduled — important in short-lived CLI/test contexts. Guarded
    // because browser-shimmed timers may not expose it.
    if (typeof this.handle.unref === 'function') this.handle.unref();
  }

  onModuleDestroy(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  /**
   * Single sample. Public so tests and future ops tooling can trigger a
   * sample on demand without waiting for the interval. Errors are caught
   * and logged here — never rethrown — so a transient sibling failure
   * does not kill subsequent ticks.
   */
  async runOnce(): Promise<void> {
    if (!this.config || !this.config.enabled) return;
    try {
      const h = await this.observability.getBridgeDeliveryHistogram(
        this.config.windowHours,
        this.config.tenantId,
      );
      this.logger.log(
        `bridge-delivery window=${this.config.windowHours}h tenant=${this.config.tenantId ?? 'default'} pending=${h.pending} delivered=${h.delivered} skipped=${h.skipped} failed=${h.failed}`,
      );
    } catch (err) {
      this.logger.error(
        'BridgeMetricsReporter runOnce failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
