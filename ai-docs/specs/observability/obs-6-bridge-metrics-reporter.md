# OBS-6: Relocate BridgeMetricsReporter into reporters/ — Spec

**Issue:** #208 (OBS-6)
**Status:** Draft
**Last Updated:** 2026-04-23
**Depends on:** OBS-5 (merged)

## Overview

Introduces `BridgeMetricsReporter` as an internal consumer of the `IObservability` facade, inside the observability combiner subsystem at `runtime/subsystems/observability/reporters/`. `@Injectable()` NestJS class with `OnModuleInit` + `OnModuleDestroy` lifecycle, which sets up `setInterval` that periodically calls `observability.getBridgeDeliveryHistogram(windowHours, tenantId?)` and logs the result via Nest `Logger`. Reporter is opt-in through a new `reporters.bridgeMetrics` shape on `ObservabilityModuleOptions`, and is auto-registered by `ObservabilityModule.forRoot(...)` only when `reporters.bridgeMetrics.enabled === true`.

**Constraint**: reporter MUST NOT reach into sibling tables, MUST NOT inject sibling tokens, MUST NOT extend `IObservability`. Strictly a facade consumer.

## Architecture

```
ObservabilityModule.forRoot(options)
         │
         │  reads options.reporters.bridgeMetrics
         ├──[enabled:true]──► providers += BridgeMetricsReporter
         │                                │
         │                                │ @Inject(OBSERVABILITY)
         │                                │ @Inject(OBSERVABILITY_MODULE_OPTIONS)
         │                                ▼
         │                         ObservabilityService ──► IJobBridge.getStatusHistogram
         │
         └──[enabled:false | missing]──► providers unchanged

Lifecycle:
Nest boot → OnModuleInit → setInterval(runOnce, intervalMs)
                                    │
                                    ▼
              runOnce() → observability.getBridgeDeliveryHistogram()
                                    ├── success → logger.log(formatted)
                                    └── reject  → logger.error(err)  [NEVER rethrows]

Nest shutdown → OnModuleDestroy → clearInterval(handle)
```

## Files

| File | Action | Purpose |
|---|---|---|
| `runtime/subsystems/observability/reporters/bridge-metrics.reporter.ts` | create | Reporter class |
| `runtime/subsystems/observability/reporters/index.ts` | create | Barrel re-exporting reporter |
| `runtime/subsystems/observability/observability.module.ts` | modify | Extend `ObservabilityModuleOptions` with `reporters.bridgeMetrics`; conditionally register reporter in `forRoot` |
| `runtime/subsystems/observability/index.ts` | modify | Re-export from `./reporters`; export new config types |
| `runtime/subsystems/observability/__tests__/bridge-metrics.reporter.spec.ts` (or matching convention) | create | Unit tests |
| `.claude/skills/observability/SKILL.md` | modify | Update "Current runtime snapshot" to reflect OBS-5 + OBS-6 landed |

## Interfaces

### Extended module options

```typescript
export interface BridgeMetricsReporterConfig {
  enabled: boolean;
  intervalMs: number;
  windowHours: number;
  tenantId?: string | null;
}

export interface ObservabilityReportersOptions {
  bridgeMetrics?: BridgeMetricsReporterConfig;
}

export interface ObservabilityModuleOptions {
  reporters?: ObservabilityReportersOptions;
}
```

The old empty-interface workaround (with its `eslint-disable` comment) goes away.

### Reporter class

```typescript
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

  onModuleInit(): void { /* see implementation */ }
  onModuleDestroy(): void { /* clearInterval */ }
  runOnce(): Promise<void> { /* delegate + log; never rethrow */ }
}
```

## Implementation steps

1. **Extend `ObservabilityModuleOptions`** — add `BridgeMetricsReporterConfig` + `ObservabilityReportersOptions` types; replace empty-interface workaround with real shape; in `forRoot`, conditionally push `BridgeMetricsReporter` onto providers when `reporters.bridgeMetrics.enabled === true`. Do not add to `exports` — internal.
2. **Create reporter class**:
   - `onModuleInit()`: if no config or disabled, log disabled message and return. Validate `intervalMs > 0` and `windowHours > 0`; log warn and return if invalid. Kick off one eager `runOnce()` immediately (first-tick eagerness — friendlier for dashboards). Set up `setInterval`. Call `.unref()` on handle if available (Node guard).
   - `onModuleDestroy()`: clear interval, null the handle. Idempotent.
   - `runOnce()`: try/catch around `observability.getBridgeDeliveryHistogram(...)`. Success → `logger.log(formatted)`. Failure → `logger.error(...)`. Never rethrow.
   - Format: single logfmt-friendly line, e.g., `bridge-delivery window=24h tenant=default pending=1 delivered=2 skipped=3 failed=4`.
3. **Create reporters barrel** — re-export `BridgeMetricsReporter` only.
4. **Update top-level observability barrel** — `export * from './reporters';` plus new config type exports.
5. **Unit tests** using `vi.useFakeTimers()` and a fake `IObservability` (plain object with mocked methods). Cases:
   - Enabled + interval fires → correct args passed
   - Tenant passthrough (`'t-a'`, `null`, `undefined`)
   - Disabled → no interval, single disabled-log
   - Missing `reporters` → no interval
   - Missing `reporters.bridgeMetrics` → no interval
   - Rejection → `logger.error` called, no propagation, next tick still fires
   - Shutdown → no further calls; idempotent on double destroy
6. **Update skill snapshot** — "Current runtime snapshot" now lists OBS-5 composer files + OBS-6 reporter files.

## Resolved open questions (decisions)

- **Log level**: `logger.log` (info) — operators see metrics by default.
- **First-tick eagerness**: eager — fire `runOnce` immediately, then interval.
- **Config defaults**: explicit — all fields required when `enabled: true`. No implicit 60s / 24h defaults.
- **`@nestjs/schedule` dependency**: NO. Use raw `setInterval` / `clearInterval` / `unref`. Avoid new peer-dep.
- **Reporters shape**: named-map (`reporters.bridgeMetrics: {...}`), not flat array. Better TS ergonomics for additional reporters later.
- **Auto-register vs consumer-explicit**: auto-register when enabled. Consumers configure via options; don't import the class directly.

## Testing strategy

- Unit tests (as above) — fast, fake facade, fake timers. No DB, no Nest test module needed.
- No integration test.
- Manual smoke (optional): scratch Nest app with bridge + observability + reporter enabled; confirm logs at interval.

## References

- ADR-025, epic #195 architecture decisions §7 (reporters)
- Skill rule 7 (reporters consume facade, not tables)
- Current observability module: `runtime/subsystems/observability/observability.module.ts`
- Precedent: `runtime/subsystems/bridge/` (prior combiner)
