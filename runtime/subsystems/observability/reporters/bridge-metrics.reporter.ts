/**
 * BridgeMetricsReporter — periodic structured-log sampler for the
 * `bridge_delivery` ledger.
 *
 * Runs on a timer (default 60s, configurable via
 * `BRIDGE_METRICS_INTERVAL_MS`) and emits ONE `Logger.log` line per tick
 * describing counts of rows that transitioned through each terminal
 * status in the last tick window, grouped by `(status, event_type,
 * skip_reason)`.
 *
 * # Placement
 *
 * Lives under `observability/reporters/` rather than in the bridge
 * subsystem itself because:
 *   1. It's not part of the bridge's functional surface — a reporter is
 *      an observability concern composed on top.
 *   2. Future reporters (Prometheus exporter, OTel bridge, etc.) slot in
 *      here with no cross-subsystem import churn.
 *
 * # Opt-in via ObservabilityModule
 *
 * The reporter is NOT provided automatically. Opt in via
 * `ObservabilityModule.forRoot({ backend, reporters: { bridgeMetrics: true } })`
 * — the module only registers the reporter when that flag is set, which
 * keeps consumers without the bridge subsystem free of its schema import
 * tax (tree-shaken; see `observability.module.ts` for the gate).
 *
 * # Why a sampler instead of in-handler logs
 *
 * The bridge subsystem writes the `bridge_delivery` ledger directly; adding
 * per-transition log lines inside the handler would double every row at
 * 1:1 cardinality. Aggregating per-tick produces the "counts per event
 * type of delivered/skipped/failed" shape that ops dashboards want,
 * without touching the bridge runtime.
 *
 * # Why aggregate-per-tick rather than per-row
 *
 * Deliveries flow at bulk-sync cadence (one event per persisted CRM
 * record). Per-row logs would be noisy and duplicative of the ledger
 * itself; aggregates match the "counts per event type of
 * delivered/skipped/failed" operator surface.
 */
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { and, eq, gt, sql } from 'drizzle-orm';

import { DRIZZLE } from '../../../constants/tokens';
import type { DrizzleClient } from '../../../types/drizzle';
import { bridgeDelivery } from '../../bridge/bridge-delivery.schema';
import { domainEvents } from '../../events/domain-events.schema';

const INTERVAL_NAME = 'bridge-metrics-tick';

/** Default sampling interval (1 minute). */
const DEFAULT_INTERVAL_MS = 60_000;

/** Minimum allowed interval — guards against env misconfig producing a hot loop. */
const MIN_INTERVAL_MS = 1_000;

export interface BridgeMetricsRow {
  status: 'pending' | 'delivered' | 'skipped' | 'failed';
  eventType: string;
  skipReason: string | null;
  count: number;
}

export interface BridgeMetricsTick {
  windowStart: Date;
  windowEnd: Date;
  rows: BridgeMetricsRow[];
}

@Injectable()
export class BridgeMetricsReporter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BridgeMetricsReporter.name);
  private readonly intervalMs: number;
  private lastTickAt: Date;
  /**
   * Timer handle retained as a field when `SchedulerRegistry` isn't
   * available (optional dep). `SchedulerRegistry` is the Nest-idiomatic
   * home for interval cleanup, but global-module wiring across consumer
   * topologies doesn't always make it injectable here — the fallback
   * keeps the reporter self-sufficient.
   */
  private ownedTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
    @Optional() private readonly scheduler: SchedulerRegistry | null = null,
  ) {
    this.intervalMs = this.resolveIntervalMs();
    // Initialize the window tail at boot so the first tick reports only
    // deliveries that transitioned after the reporter started.
    this.lastTickAt = new Date();
  }

  onModuleInit(): void {
    this.logger.log(
      `BridgeMetricsReporter starting (intervalMs=${this.intervalMs}).`,
    );
    const timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Allow the process to exit naturally in test runs — setInterval
    // otherwise pins the event loop open.
    timer.unref?.();

    if (this.scheduler) {
      this.scheduler.addInterval(INTERVAL_NAME, timer);
    } else {
      // Fallback: retain the handle ourselves so onModuleDestroy can
      // clear it without Nest's SchedulerRegistry.
      this.ownedTimer = timer;
    }
  }

  onModuleDestroy(): void {
    if (this.scheduler && this.scheduler.getIntervals().includes(INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
    if (this.ownedTimer !== null) {
      clearInterval(this.ownedTimer);
      this.ownedTimer = null;
    }
  }

  /**
   * Run one sampling tick. Public so tests can drive it deterministically
   * without waiting on the timer.
   */
  async tick(): Promise<BridgeMetricsTick> {
    const windowStart = this.lastTickAt;
    const windowEnd = new Date();
    this.lastTickAt = windowEnd;

    let rows: BridgeMetricsRow[] = [];
    try {
      rows = await this.sample(windowStart, windowEnd);
    } catch (err) {
      this.logger.error(
        `bridge metrics sample failed: ${(err as Error).message}`,
      );
      return { windowStart, windowEnd, rows: [] };
    }

    this.emit({ windowStart, windowEnd, rows });
    return { windowStart, windowEnd, rows };
  }

  private async sample(
    windowStart: Date,
    windowEnd: Date,
  ): Promise<BridgeMetricsRow[]> {
    // Terminal transitions land `delivered_at` for `delivered`, and leave
    // `attempted_at` as the most recent timestamp for `skipped`/`failed`.
    // Window on COALESCE so terminal skipped/failed rows are captured
    // alongside delivered. Upper edge bounded by windowEnd so a long tick
    // can't double-count rows that transitioned between sample and emit.
    const lastTransition = sql<Date>`COALESCE(${bridgeDelivery.deliveredAt}, ${bridgeDelivery.attemptedAt})`;

    const result = await this.db
      .select({
        status: bridgeDelivery.status,
        eventType: domainEvents.type,
        skipReason: bridgeDelivery.skipReason,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(bridgeDelivery)
      .innerJoin(domainEvents, eq(bridgeDelivery.eventId, domainEvents.id))
      .where(
        and(
          gt(lastTransition, windowStart),
          sql`${lastTransition} <= ${windowEnd}`,
        ),
      )
      .groupBy(
        bridgeDelivery.status,
        domainEvents.type,
        bridgeDelivery.skipReason,
      );

    return result.map((r) => ({
      status: r.status as BridgeMetricsRow['status'],
      eventType: r.eventType,
      skipReason: r.skipReason,
      count: r.count,
    }));
  }

  private emit(tick: BridgeMetricsTick): void {
    if (tick.rows.length === 0) {
      // Heartbeat — confirms the sampler is alive when deliveries are idle.
      // Cheap enough at default 60s cadence; operators rely on this signal
      // to distinguish "bridge quiet" from "reporter dead".
      this.logger.log(
        `bridge_metrics tick=empty window=[${tick.windowStart.toISOString()}..${tick.windowEnd.toISOString()}]`,
      );
      return;
    }

    const totals = tick.rows.reduce(
      (acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + r.count;
        return acc;
      },
      {} as Record<string, number>,
    );

    const detail = tick.rows
      .map(
        (r) =>
          `${r.eventType}|${r.status}${r.skipReason ? `:${r.skipReason}` : ''}=${r.count}`,
      )
      .join(' ');

    this.logger.log(
      `bridge_metrics tick window=[${tick.windowStart.toISOString()}..${tick.windowEnd.toISOString()}] ` +
        `totals=${JSON.stringify(totals)} detail=[${detail}]`,
    );
  }

  private resolveIntervalMs(): number {
    const raw = process.env['BRIDGE_METRICS_INTERVAL_MS'];
    if (!raw) return DEFAULT_INTERVAL_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS) {
      new Logger(BridgeMetricsReporter.name).warn(
        `Ignoring BRIDGE_METRICS_INTERVAL_MS='${raw}' (invalid or < ${MIN_INTERVAL_MS}ms); ` +
          `using default ${DEFAULT_INTERVAL_MS}ms.`,
      );
      return DEFAULT_INTERVAL_MS;
    }
    return parsed;
  }
}
