# Epic #195 — Architecture Decisions (locked)

Distilled from:
- `.claude/specs/epic-195-understanding.md`
- `.claude/specs/observability-subsystem-shape-understanding.md`
- `.claude/specs/observability-app-service-layer-understanding.md`

These decisions are **locked** going into the planning phase. The planner should not re-litigate; treat as constraints.

## 1. Shape: combiner subsystem (not ADR-008 infrastructure subsystem)

Observability is a **framework-level combiner subsystem** mirroring `BridgeModule` / `EventFlowService`. It lives in `runtime/subsystems/observability/` but is structurally distinct from ADR-008 infrastructure subsystems (events/jobs/cache/storage):

| Aspect | ADR-008 infra subsystem | Observability (combiner) |
|---|---|---|
| Owns schema | Yes | **No** |
| Backend-swappable (`forRoot({ backend })`) | Yes | **No** — backend is inherited from the subsystems it calls |
| Memory + Drizzle backend classes | Yes | **No** — one service class, delegates to sibling ports |
| Read or write | Write + read | **Read-only** |
| Precedent | events, jobs, cache, storage | bridge (EventFlowService composes IEventBus + IJobOrchestrator + BRIDGE_DELIVERY_REPO) |

**The observability ADR must explicitly call out this shape distinction.** Do not ship the epic's original "5th infrastructure subsystem" framing — it's structurally dishonest.

## 2. Naming (matches repo convention, does not invent vocabulary)

- Protocol: `IObservability` (not `IObservabilityService` — the `I` prefix + port name is sufficient, matches `IEventFlow`)
- Service class: `ObservabilityService` (matches `EventFlowService`)
- Token: `OBSERVABILITY` (matches `EVENT_FLOW`)
- Module: `ObservabilityModule`

**No `ApplicationService` naming.** That term does not exist in the codebase; introducing it would create new vocabulary for a pattern that already has a name ("combiner subsystem").

## 3. Layering: subsystems are two-layer, not three

Framework subsystems follow **protocol → backend**, not **protocol → service → repo**. The `use-case → service → repo` rule (confirmed in #200) is entity-pipeline-only.

Consequences:
- Observability calls protocol ports directly (`IJobRunService.countByPoolAndStatus()`), not through a service wrapping a repo
- New read methods get added to the existing ports + both backends (Drizzle + Memory)
- No separate "repo" layer is introduced in framework subsystems — the backend IS the port impl
- Migration to three-layer is possible later and cheap (mechanical rename + one-level indirection, no call-site churn) — but not required for phase 1

## 4. Per-subsystem read additions

Each owning subsystem adds new methods to its existing protocol + both backends. These are the meat of the plan:

| Subsystem | Protocol | Methods to add |
|---|---|---|
| jobs | `IJobRunService` | `countByPoolAndStatus(tenantId?)`, `listRecentFailed(limit, tenantId?)` |
| bridge | `IBridgeDeliveryRepo` | `getStatusHistogram(windowHours, tenantId?)` — explicit on whether "histogram" is status counts or time-bucketed |
| sync | `ISyncRunRecorder` (or equivalent read port) | `listRecent(limit, integrationId?)` |
| sync | `ICursorStore` | `listAll(tenantId?)` — **cursor is NOT its own subsystem, lives in sync** |
| events | `IEventBus` or a new `IEventBusReader` | (tbd — observability phase 1 may not need event reads; defer) |

Each addition is a PR in the owning subsystem. These gate the observability composer.

## 5. Multi-tenancy

All read methods must accept an optional `tenantId` parameter matching the jobs convention (`job-orchestrator.protocol.ts`). Never re-implement tenant filtering in observability — delegate to the owning port. The biggest footgun from the understanding.

## 6. Histogram shape

Decided: `getStatusHistogram(windowHours)` returns **plain status counts** for phase 1 (`{ delivered: N, failed: N, skipped: N, pending: N }`). Time-bucketed series are out of scope and would belong in the Cube.js analytics layer, not in observability protocol.

## 7. What's out of scope for phase 1

- **Drizzle extensions** (`pg_stat_activity`, `pg_stat_statements`, `LISTEN/NOTIFY`). Defer to phase 2. Phase 1 ships only the core composer.
- **StackStatusService wiring** (the incoming consumer). Consumer-side, belongs in dealbrain-v2, not in this framework epic.
- **Prometheus / OpenTelemetry exporters.** Belong in `reporters/` if added; not part of phase 1 core.
- **Cross-table analytics JOINs.** Explicitly reserved for future Cube.js layer.

## 8. ADR requirement

The epic ships with a new ADR (or ADR-008 addendum) that:
- Introduces "combiner subsystem" as a named pattern distinct from "infrastructure subsystem"
- Names bridge as the existing precedent
- Defines the shape: framework-level, no schema, no backend-swappability, composes sibling ports via DI, `global: true`
- Calls out that entity-code's `use-case → service → repo` rule does not apply to framework subsystems (which are two-layer)

Per CLAUDE.md "living documentation" — ADR ships in the same PRs as implementation.

## 9. Skill requirement

New `.claude/skills/observability/SKILL.md` patterned after `.claude/skills/jobs/SKILL.md` and `.claude/skills/bridge/SKILL.md`. Must document:
- Combiner pattern and how it differs from infrastructure subsystems
- When to add a read method to an existing port vs. create a new port
- Multi-tenancy rule: always delegate to owning port's tenantId gating
- Cube.js reservation for cross-table analytics
