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
