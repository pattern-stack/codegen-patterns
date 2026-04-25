# OBS-1: ADR + skill scaffold for combiner subsystem pattern — Spec

**Issue:** #202 (OBS-1)
**Status:** Draft
**Last Updated:** 2026-04-23

## Overview

Two documentation artifacts to ship in one PR:
1. New ADR introducing "combiner subsystem" as a named pattern distinct from ADR-008 infrastructure subsystems
2. New `.claude/skills/observability/SKILL.md` patterned after `.claude/skills/bridge/SKILL.md`

No code changes.

## ADR number

**ADR-025.** On-disk numbering shows 008 → 011 → 015..024 → 030 → 031 (two files at 031). Lowest vacant slot after 024 is 025. (An earlier draft suggested 028 as a defensive choice against reserved-but-unwritten slots; verified on disk — 025/026/027 are truly vacant.)

Filename: `docs/adrs/ADR-025-combiner-subsystems.md`

## Files

| File | Action | Purpose |
|------|--------|---------|
| `docs/adrs/ADR-025-combiner-subsystems.md` | create | Name the combiner pattern; contrast with ADR-008; close the two-layer rule |
| `.claude/skills/observability/SKILL.md` | create | Domain skill for observability work |

## Drafted ADR content

Full content to write to `docs/adrs/ADR-025-combiner-subsystems.md`:

---

```markdown
# ADR-025 — Combiner Subsystems

**Status:** Draft
**Date:** 2026-04-23
**Owner:** Doug
**Related:** ADR-008 (Infrastructure Subsystem Pattern), ADR-023 (Event-to-Job Bridge), ADR-024 (Events Domain Formalization), ADR-022 (Job Orchestration Domain Model)
**Unblocks:** Epic #195 (Observability Subsystem), future cross-subsystem read facades
**Depends on:** ADR-008, ADR-023 (bridge is the named precedent)

## Context

ADR-008 established the shape of an "infrastructure subsystem": a `runtime/subsystems/<name>/` directory owning a protocol (`IEventBus`, `IJobOrchestrator`, `ICacheService`, `IStorageService`), a schema file, one or more backend implementations (`drizzle`, `memory`, `redis`), a `<Name>Module.forRoot({ backend })` factory, `global: true`, and a tokens module. Events, jobs, cache, and storage all follow it. New contributors learn the pattern once and apply it four times.

The pattern has an important but undocumented limit: **it assumes the subsystem owns durable state.** The "backend" choice is meaningful precisely because each backend stores the subsystem's own schema differently (Drizzle in Postgres tables; Memory in in-process maps; Redis in keyspaces). Forcing a subsystem into ADR-008 when it owns no state produces a fake backend toggle — `MemoryFooService` and `DrizzleFooService` end up as near-identical pass-throughs because there is nothing to persist.

Two real subsystems do not own state and do not fit ADR-008:

1. **Bridge (ADR-023).** Shipped 2026-04-22. The bridge owns `bridge_delivery` as a ledger but — decisively — its `IEventFlow` facade (`runtime/subsystems/bridge/event-flow.service.ts`) composes `EVENT_BUS` and `JOB_ORCHESTRATOR` via DI to produce the "publish + start" verb. `BridgeModule`'s own docstring names itself "the combiner — neither `EventsModule` nor `JobsDomainModule` know about it." Neither sibling subsystem imports bridge; bridge imports from both.

2. **Observability (epic #195, in-flight).** A cross-subsystem read facade that composes `IJobRunService` + `IJobBridge` + sync ports + cursor store to expose dashboard-grade reads (`getPoolDepths`, `getRecentSyncRuns`, `getBridgeDeliveryHistogram`, `getRecentFailedJobs`, `getCursors`). It owns no schema — every row it returns was written by another subsystem. It has no meaningful backend choice because the backend is whichever backend the composed subsystems are running.

Epic #195's original framing called observability "the 5th infrastructure subsystem." That framing is structurally dishonest: it would promise a backend toggle the subsystem cannot deliver, and it would invite future contributors to write parallel `Memory`/`Drizzle` observability backends that are indistinguishable pass-throughs. Bridge already lives in the codebase as the right shape but was introduced without a name for that shape. This ADR names it.

While naming the pattern, this ADR also closes a second ambiguity that has surfaced repeatedly during implementation: whether framework subsystems are two-layer (protocol → backend) or three-layer (protocol → service → repo). They are two-layer. The `use-case → service → repo` rule is entity-pipeline-only. This has been implicit since ADR-008 but is absent from the ADR text and surfaced as an open question during epic #195 planning (see `.claude/specs/observability-subsystem-shape-understanding.md`).

## Decision

### 1. Introduce "combiner subsystem" as a named pattern

A **combiner subsystem** is a framework-level subsystem that composes other subsystems' public tokens via DI, exposing a unified facade. It is distinct from ADR-008 "infrastructure subsystems" along five axes:

| Aspect | ADR-008 infrastructure subsystem | Combiner subsystem |
|---|---|---|
| Lives in `runtime/subsystems/<name>/` | Yes | Yes |
| Owns a schema file | Yes | **No** |
| Backend-swappable via `forRoot({ backend })` | Yes | **No** |
| Ships Memory + Drizzle backend variants | Yes | **No** — single service class |
| Composes sibling subsystem tokens via DI | Sometimes | **Always** — this is the point |
| `global: true` module | Yes | Yes |
| Consumed by siblings | Directly via token | **No** — siblings do not know the combiner exists |

Existing precedent: **bridge (ADR-023).** `BridgeModule` imports neither `EventsModule` nor `JobsDomainModule` in the Nest sense — it consumes `EVENT_BUS` and `JOB_ORCHESTRATOR` through DI, which the consumer app wires by registering the modules in the right order.

The pattern is orthogonal to what the combiner does with its composed ports. Bridge is a **write orchestrator** (its load-bearing method opens a `db.transaction` and threads `tx` across three subsystems atomically). Observability is a **read composer** (no transaction, no mutation). Both are combiners.

### 2. Shape

```
runtime/subsystems/<name>/
  <name>.protocol.ts          # I<Name> protocol and public types
  <name>.service.ts           # Single <Name>Service class; composes sibling tokens via DI
  <name>.module.ts            # <Name>Module; global: true; forRoot({ ...options }) — NO backend key
  <name>.tokens.ts            # <NAME> symbol
  <name>-errors.ts            # <Name>Error base
  index.ts                    # Barrel — re-exports protocol + types + tokens + module (not service class)
```

Key constraints:
- **Single service class.** No `Memory<Name>Service` / `Drizzle<Name>Service` split.
- **`forRoot(options)` may take options but not `backend`.** Options can include feature toggles, tenancy flags — never a backend discriminator.
- **Sibling tokens are consumed via `@Optional()` DI where sensible.** A combiner may be installed into an app that has not installed every sibling; degrade gracefully (empty results for absent ports, not throw).
- **Siblings do not know about the combiner.** If `EventsModule` ever imports from `runtime/subsystems/<combiner>/`, the boundary has been violated.

### 3. Framework subsystems are two-layer (protocol → backend)

Framework subsystems under `runtime/subsystems/` follow **protocol → backend**. There is no intermediate "service" layer. The word "Service" in class names like `DrizzleJobRunService`, `EventFlowService`, `ObservabilityService` denotes a **port role**, not a Clean Architecture tier. `DrizzleJobRunService` IS the backend — it implements `IJobRunService` directly, owns the SQL, enforces multi-tenancy. There is no `JobRunService` wrapping a `JobRunRepository`.

The `use-case → service → repo` rule applies **only** to entity-pipeline code (clean-lite-ps generated output). Framework subsystems follow **protocol → backend**. Applying the three-layer rule here would invent a layer that does not exist anywhere in the runtime directory.

New observability reads added during epic #195 (`IJobRunService.countByPoolAndStatus`, `IJobBridge.getStatusHistogram`, etc.) extend the existing ports and land in the existing backend classes. They do not introduce a repository layer underneath.

### 4. When to pick combiner vs. infrastructure

| You have... | Use |
|---|---|
| Durable state of your own, backend-specific representation matters | ADR-008 infrastructure subsystem |
| No durable state; your job is to compose sibling subsystems | Combiner subsystem (this ADR) |
| Durable state but you also compose siblings (e.g., bridge's ledger) | Combiner subsystem — the ledger is an implementation detail of the composition, not a backend-swappable public contract |

### 5. Extensions as variants within the pattern

Future combiners may diverge in minor ways:
- A combiner with its own durable state (like bridge) may accept a `backend` key for its *internal* port, but its public `I<Name>` facade remains single-implementation.
- A combiner that is strictly stateless (like observability phase 1) takes no `backend` key.
- A combiner may expose reporters (internal `OnModuleInit` + `setInterval` consumers that do not extend the protocol). Observability will; bridge does not.

These are variants within the combiner pattern. Document them in the subsystem's own skill file, not in new ADRs.

## Consequences

**Positive:**
- Future subsystems have a second named shape. The "observability is the 5th infrastructure subsystem" framing is no longer a trap.
- Bridge is retroactively named. Its shape was right; the ADR corpus now admits it exists.
- The two-layer rule for framework subsystems is documented.
- Contributors adding a new cross-subsystem facade have a template.

**Negative / accepted tradeoffs:**
- Two shapes of subsystem in the ADR corpus. Contributors have to pick. The decision table makes it mechanical.
- Combiners are less portable across radically different backends because they don't have a `backend` key. Correct — portability inherited from composed ports.

**Phase-1 scope note:**
Observability phase 1 will not be backend-swappable because it owns no state. If a future combiner needs durable state (caching aggregated reads, memoizing expensive JOINs), it may grow a backend key for that internal state — variant within this pattern, not a violation of it.

## Alternatives considered

### A. Force observability into the ADR-008 shape
Ship observability with `forRoot({ backend })`, `MemoryObservabilityService`, `DrizzleObservabilityService`, even though both backends would be near-identical pass-throughs.

**Rejected.** Structurally dishonest. The toggle would be a ceremony with no semantics, inviting contributors to add real divergence over time and recreating the wart this ADR exists to prevent.

### B. Consumer-level composer
Put the observability composer in the consumer app rather than in `runtime/subsystems/`.

**Rejected.** Breaks symmetry with bridge, which ships its composer as framework code so consumers don't re-compose events + jobs themselves.

### C. Extend ADR-008 with an addendum rather than a new ADR
**Rejected.** The two shapes differ on five axes and have different authoring guidance. An addendum would dilute ADR-008's clarity.

### D. Ship the combiner shape silently, skip the ADR
**Rejected.** Without a named ADR, the next cross-subsystem facade will re-litigate the ADR-008 question from scratch.

## References

- ADR-008 — Infrastructure Subsystem Pattern (the shape this ADR contrasts with)
- ADR-023 — Event-to-Job Bridge (the existing combiner, named as precedent)
- ADR-024 — Events Domain Formalization (one of the subsystems bridge composes)
- ADR-022 — Job Orchestration Domain Model (one of the subsystems bridge composes)
- Epic #195 — Observability subsystem (the second combiner, in-flight)
- Issue #200 — Surfaced the two-layer rule for framework subsystems
- `.claude/specs/epic-195-architecture-decisions.md` — locked decisions this ADR implements
```

---

## Drafted skill content

Full content to write to `.claude/skills/observability/SKILL.md`:

---

```markdown
---
name: observability
description: Load when working on the Observability combiner subsystem. Triggers include anything under `runtime/subsystems/observability/`; the `IObservability` protocol or `OBSERVABILITY` token; `ObservabilityModule.forRoot()` wiring; `ObservabilityService` and its composed sibling ports (`IJobRunService`, `IJobBridge`, sync recorder/cursor ports); reporters living under `runtime/subsystems/observability/reporters/`; relocation of `BridgeMetricsReporter`; the `just gen-subsystem observability` scaffold; and any work referencing ADR-025, epic #195, or OBS-1..OBS-8 specs.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

# Observability Domain Skill

**Phase status:** In-flight via epic #195 (OBS-1..OBS-8). ADR-025 is `Draft`. Phase 1 ships the composer, per-sibling read additions, `BridgeMetricsReporter` relocation, and the CLI scaffold. Phase 2 (Drizzle extensions, Prometheus/OTel exporters, Cube.js cross-table analytics) is deferred.

Observability is the **combiner subsystem** that composes read-side reporting across jobs, bridge, sync, and the cursor store. Its job is to turn "how is the system doing?" into a single typed port — multi-tenant-safe, backend-inherited, dashboard-grade.

## Mental model

**Read-only composer, not an infrastructure subsystem.** Observability is a combiner per ADR-025 — owns no schema, no `backend` key on `forRoot()`, single `ObservabilityService` class. The "backend" for observability is whatever backends the composed subsystems are running; portability is inherited, not declared.

**Five core reads in phase 1:**

| Method | Delegates to | Owning subsystem |
|---|---|---|
| `getPoolDepths(tenantId?)` | `IJobRunService.countByPoolAndStatus` | jobs |
| `getRecentFailedJobs(limit, tenantId?)` | `IJobRunService.listRecentFailed` | jobs |
| `getBridgeDeliveryHistogram(windowHours, tenantId?)` | `IJobBridge.getStatusHistogram` | bridge |
| `getRecentSyncRuns(limit, subscriptionId?, tenantId?)` | `ISyncRunRecorder.listRecent` | sync |
| `getCursors(tenantId?)` | `ICursorStore.listAll` | sync (cursor store lives in sync) |

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

In: OBS-1..OBS-8 (see `.claude/specs/epic-195-plan.md`).

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

**None.** `runtime/subsystems/observability/` does not exist yet. OBS-5..OBS-8 will populate it. Rewrite this section when they land.

Expected files (per plan):
```
runtime/subsystems/observability/
  observability.protocol.ts
  observability.service.ts
  observability.module.ts
  observability.tokens.ts
  observability-errors.ts
  reporters/bridge-metrics.reporter.ts
  reporters/index.ts
  index.ts
```

## Cross-links

- `docs/adrs/ADR-025-combiner-subsystems.md`
- `docs/adrs/ADR-008-subsystem-architecture.md`
- `docs/adrs/ADR-023-event-to-job-bridge.md`
- `.claude/specs/epic-195-architecture-decisions.md`
- `.claude/specs/epic-195-plan.md`
- `.claude/skills/bridge/SKILL.md`
- `.claude/skills/jobs/SKILL.md`
- `.claude/skills/events/SKILL.md`
```

## Acceptance criteria

- [ ] `docs/adrs/ADR-025-combiner-subsystems.md` exists with content above
- [ ] `.claude/skills/observability/SKILL.md` exists with content above
- [ ] No code changes
- [ ] Pre-existing ADR-031 collision (two files at slot 031) is NOT touched — pre-existing issue, not ours

## References

- Epic: #195
- Plan: `.claude/specs/epic-195-plan.md`
- Decisions: `.claude/specs/epic-195-architecture-decisions.md`
- Understandings: `.claude/specs/epic-195-understanding.md`, `observability-subsystem-shape-understanding.md`, `observability-app-service-layer-understanding.md`
