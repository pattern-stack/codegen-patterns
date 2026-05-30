---
name: observability
description: Load when working on the Observability combiner subsystem. Triggers include anything under `runtime/subsystems/observability/`; the `IObservability` protocol or `OBSERVABILITY` token; `ObservabilityModule.forRoot()` wiring; `ObservabilityService` and its composed sibling ports (`IJobRunService`, `IJobBridge`, integration recorder/cursor ports); reporters living under `runtime/subsystems/observability/reporters/`; relocation of `BridgeMetricsReporter`; the `just gen-subsystem observability` scaffold; and any work referencing ADR-025, epic #195, or OBS-1..OBS-8 specs.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

# Observability Domain Skill

**Phase status:** In-flight via epic #195 (OBS-1..OBS-8). ADR-025 is `Draft`. Phase 1 ships the composer, per-sibling read additions, `BridgeMetricsReporter` relocation, and the CLI scaffold. Phase 2 (Drizzle extensions, Prometheus/OTel exporters, Cube.js cross-table analytics) is deferred.

Observability is the **combiner subsystem** that composes read-side reporting across jobs, bridge, integration, and the cursor store. Its job is to turn "how is the system doing?" into a single typed port — multi-tenant-safe, backend-inherited, dashboard-grade.

## Mental model

**Read-only composer, not an infrastructure subsystem.** Observability is a combiner per ADR-025 — owns no schema, no `backend` key on `forRoot()`, single `ObservabilityService` class. The "backend" for observability is whatever backends the composed subsystems are running; portability is inherited, not declared.

**Five core reads in phase 1:**

| Method | Delegates to | Owning subsystem |
|---|---|---|
| `getPoolDepths(tenantId?)` | `IJobRunService.countByPoolAndStatus` | jobs |
| `getRecentFailedJobs(limit, tenantId?)` | `IJobRunService.listRecentFailed` | jobs |
| `getBridgeDeliveryHistogram(windowHours, tenantId?)` | `IJobBridge.getStatusHistogram` | bridge |
| `getRecentIntegrationRuns(limit, subscriptionId?, tenantId?)` | `IIntegrationRunRecorder.listRecent` | integration |
| `getCursors(tenantId?)` | `ICursorStore.listAll` | integration (cursor store lives in integration) |

**Reporters are internal consumers, not protocol extensions.** `BridgeMetricsReporter` lives under `runtime/subsystems/observability/reporters/`, injects `OBSERVABILITY`, runs on `OnModuleInit` + `setInterval`. It consumes `IObservability` — does not extend the protocol.

**Graceful subsystem absence.** `ObservabilityService` uses `@Optional()` for each sibling port injection. Missing sibling → empty result (e.g., zero histogram), not throw.

## Non-obvious rules

### 1. Combiner shape, not infrastructure subsystem

Observability is a **combiner subsystem** per ADR-025. Do not retrofit it with a `backend` key to preserve symmetry with events/jobs/cache/storage. The asymmetry is the point. A single `ObservabilityService` class is correct.

### 2. Framework subsystems are two-layer (protocol → backend)

Framework subsystems follow **protocol → backend**. No intermediate service layer. "Service" in class names denotes a port role, not a Clean Architecture tier. The `use-case → service → repo` rule applies **only** to entity-pipeline code, not framework subsystems.

### 3. Multi-tenancy: always delegate to the owning port

Every `IObservability` method accepts optional `tenantId` and passes it through to the owning port. **Never re-implement tenant filtering in `ObservabilityService`.** This is the biggest footgun — if observability duplicates the WHERE clause, the next tenancy change silently misses it.

### 4. New reads land in the owning subsystem first

If a consumer needs a new read, the extension goes on the owning port (`IJobRunService`, etc.), implemented in both backends, accepting optional `tenantId`. Then observability composes it. Do not add tabular SQL to `ObservabilityService` that duplicates semantic knowledge the owning subsystem already encodes.

### 5. Cross-table JOIN analytics defer to Cube.js

Observability reads are scoped to a single owning subsystem per method. Cross-subsystem JOINs belong in a future Cube.js layer.

### 6. Histograms are plain counts in phase 1

`getBridgeDeliveryHistogram` returns `{ pending, delivered, skipped, failed }`. No time bucketing — that's Cube.js territory.

### 7. Reporters consume the facade, never sibling tables

`BridgeMetricsReporter` injects `OBSERVABILITY`, calls `observability.getBridgeDeliveryHistogram()`. Must not inject `BRIDGE_DELIVERY_REPO` or similar directly.

### 8. Drizzle extensions are phase 2 only

`pg_stat_activity`, `pg_stat_statements`, `LISTEN/NOTIFY` — deferred.

## Phase 1 scope

In: OBS-1..OBS-8 (see `ai-docs/specs/epic-195-plan.md`).

Out (phase 2+): Drizzle extensions, Prom/OTel exporters, StackStatusService wiring, Cube.js, time-bucketed histograms, events reads.

## Do not

- Do not introduce Memory/Drizzle backend variants of `ObservabilityService`
- Do not add a `backend` key to `ObservabilityModule.forRoot()`
- Do not re-implement tenant filtering in `ObservabilityService`
- Do not reach into sibling tables from `ObservabilityService` or reporters
- Do not add cross-subsystem JOIN queries (Cube.js territory)
- Do not extend the protocol surface from inside `reporters/`
- Do not land `pg_stat_*` or `LISTEN/NOTIFY` in phase 1
- Do not grow the histogram signature to bucket widths or time series
- Do not invent a `use-case → service → repo` layering inside `runtime/subsystems/observability/`
- Do not retain the old app-side `BridgeMetricsReporter` as a shim after OBS-6 lands

## Current runtime snapshot

Epic #195 fully shipped. All eight phase-1 issues (OBS-1..OBS-8) merged.

```
runtime/subsystems/observability/
  observability.protocol.ts        # IObservability + composed types
  observability.service.ts         # ObservabilityService — single composer class
  observability.module.ts          # ObservabilityModule.forRoot({ reporters? }), global: true
  observability.tokens.ts          # OBSERVABILITY, OBSERVABILITY_MODULE_OPTIONS
  observability-errors.ts          # ObservabilityError base
  index.ts                         # Barrel — protocol + types + tokens + module + errors
  reporters/
    bridge-metrics.reporter.ts     # @Injectable, OnModuleInit + setInterval, opt-in via options
    index.ts

src/__tests__/runtime/subsystems/
  observability.service.spec.ts            # composer delegation + @Optional() degradation
  observability.module.spec.ts             # module wiring tests
  observability.bridge-metrics.reporter.spec.ts  # reporter lifecycle + tenant passthrough
  job-run-service.observability.unit.spec.ts     # OBS-2 jobs port-extension tests

templates/subsystem/observability/
  prompt.js
  main-hook.ejs.t                  # Comment hint into app.module.ts (jobs-pattern)

templates/subsystem/observability-config/
  prompt.js
  codegen-config-observability-block.ejs.t   # observability: defaults block
```

CLI install: `codegen subsystem install observability` (or `just gen-subsystem observability`).
Backend literal in CLI registry: `'combiner'` (parallel to `'config-only'`).

Phase 1 surface complete. Phase 2 deferred per scope.

## Cross-links

- `docs/adrs/ADR-025-combiner-subsystems.md`
- `docs/adrs/ADR-008-subsystem-architecture.md`
- `docs/adrs/ADR-023-event-to-job-bridge.md`
- `ai-docs/specs/epic-195-architecture-decisions.md`
- `ai-docs/specs/epic-195-plan.md`
- `.claude/skills/bridge/SKILL.md`
- `.claude/skills/jobs/SKILL.md`
- `.claude/skills/events/SKILL.md`
