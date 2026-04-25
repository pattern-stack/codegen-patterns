# Understanding — Observability subsystem shape (internal layering of runtime/subsystems/*)

## The question

Do `runtime/subsystems/*` subsystems (jobs, events, bridge, sync, etc.) have a three-layer `protocol → service → repo` structure, or something else?

## Answer

**No service layer exists between protocol and backend.** These subsystems are **two-layer (protocol + backend)**, not three-layer. This is explicit, not accidental — the jobs skill calls it out as "single-layer architecture (do not forget this)."

The word "Service" in class names like `IJobRunService` / `DrizzleJobRunService` / `EventFlowService` denotes a **port role** (scoped-queries port, flow-facade port), not a Clean Architecture **tier**. There is no `JobRunService` wrapping a `JobRunRepository`.

## Per-subsystem breakdown

### Jobs (`runtime/subsystems/jobs/`)
- Protocols: `job-orchestrator.protocol.ts` (`IJobOrchestrator`), `job-run-service.protocol.ts` (`IJobRunService`), `job-step-service.protocol.ts` (`IJobStepService`)
- Backends: `job-orchestrator.drizzle-backend.ts` (`DrizzleJobOrchestrator`), `job-run-service.drizzle-backend.ts` (`DrizzleJobRunService`), `job-step-service.drizzle-backend.ts`, and memory equivalents
- `DrizzleJobRunService` is named "Service" but IS the backend — implements `IJobRunService` directly, owns the SQL (drizzle-orm `and/eq/inArray`), enforces multi-tenancy via `tenantCondition()`, and talks to `DRIZZLE`
- Worker loop lives in `job-worker.module.ts` + `job-orchestrator.drizzle-backend.ts`; pool claim filter, state transitions, and any lifecycle event emission belong in the backend class itself

### Events (`runtime/subsystems/events/`)
- Protocol: `event-bus.protocol.ts` (`IEventBus` — narrow 3-method port: `publish`, `publishMany`, `subscribe`)
- Backends: `event-bus.drizzle-backend.ts` (`DrizzleEventBus` — outbox + poller), `event-bus.memory-backend.ts`, `event-bus.redis-backend.ts`
- `TypedEventBus` in `generated/bus.ts` is a thin facade wrapping `IEventBus` to stamp metadata — not a service tier, a codegen-emitted convenience
- Write coordination (pool routing, tenantId enforcement, outbox drain) lives in `DrizzleEventBus` directly

### Bridge (`runtime/subsystems/bridge/`)
- Protocols/tokens: `bridge.protocol.ts`, `bridge.tokens.ts` (`IJobBridge`, `IEventFlow`, `IBridgeOutboxDrainHook`)
- Backends: `bridge-delivery.drizzle-backend.ts` (`DrizzleBridgeDeliveryRepo`), `bridge-delivery.memory-backend.ts` (`MemoryBridgeDeliveryRepo`)
- Other: `event-flow.service.ts` (`EventFlowService` — facade impl of `IEventFlow`), `bridge-delivery-handler.ts` (framework `@JobHandler`), `bridge-outbox-drain-hook.ts`
- Bridge has both repo-named and service-named classes, but they're not layered against each other: `EventFlowService` is the `IEventFlow` facade port impl (coordinates `IEventBus` + `IJobOrchestrator` + `bridgeRepo` in one tx), not a service-layer wrapper. The "repo" is itself a core port (`BRIDGE_DELIVERY_REPO`).

## Skill confirmation

Both `.claude/skills/jobs/SKILL.md` and `.claude/skills/events/SKILL.md` frame the architecture as **protocol → backend**, not protocol → service → repo:
- Jobs SKILL §"Single-layer architecture": "There is **no** `IJobQueue`, **no** `job_queue` table, **no** executor port."
- Events SKILL names the pattern `Protocol → Backend → Factory` (ADR-008) and treats `TypedEventBus` as a facade, not a tier.
- Bridge SKILL lists expected files as protocol + schema + backends + handler + facade service + module — no service/repo split.

## Where `countByPoolAndStatus()` / `getHistogram()` would land

Two naturally ergonomic homes:

1. **Extend the existing port** (preferred if it's portable): add a method to `IJobRunService` in `job-run-service.protocol.ts` and implement in `job-run-service.drizzle-backend.ts` + `job-run-service.memory-backend.ts`. Keeps the core-contract portability promise.

2. **New peer port** if the shape doesn't fit: e.g. `IJobMetricsService` / `IJobObservability` as a separate protocol file, parallel Drizzle + Memory backends.

What does NOT fit the existing convention: inserting a `JobRunService` class that composes `IJobRunRepository` underneath. That would contradict the explicit single-layer decision and require re-naming the existing backend to "repository," churning every call site.

## Implication for the observability composer

**The entity-code rule `use-case → service → repo` does NOT apply to framework subsystems.** That rule is for clean-lite-ps entity-generated code. Framework subsystems have their own convention: **app code → protocol port → backend**. "Service" in port names is a role label, not a tier.

Consequences for epic #195:
- Observability composer composes **protocol port calls** — `IJobRunService.listForScope()`, a new `IJobRunService.countByPoolAndStatus()`, `IBridgeDeliveryRepo.*`, etc.
- Each owning subsystem adds observability reads to **its own port + backend pair** (core-contract extension, per CLAUDE.md). Memory backends must implement too — no port should be Drizzle-only.
- The composer itself, if it lives as a cross-subsystem read facade under `runtime/subsystems/observability/`, is a new protocol + backend pair consuming other subsystems' tokens via DI — **structurally identical to how `BridgeModule` consumes `EVENT_BUS` + `JOB_ORCHESTRATOR`**.
- Writing the composer as "calls services that call repos" would introduce a layering that does not exist anywhere else in `runtime/subsystems/` and would be the odd one out.

## Key file paths

- `runtime/subsystems/jobs/job-run-service.protocol.ts`
- `runtime/subsystems/jobs/job-run-service.drizzle-backend.ts`
- `runtime/subsystems/jobs/jobs-domain.module.ts`
- `runtime/subsystems/events/event-bus.protocol.ts`
- `runtime/subsystems/events/event-bus.drizzle-backend.ts`
- `runtime/subsystems/bridge/bridge.module.ts`
- `runtime/subsystems/bridge/event-flow.service.ts`
- `.claude/skills/jobs/SKILL.md`
- `.claude/skills/events/SKILL.md`
- `.claude/skills/bridge/SKILL.md`

## Load-bearing decisions

- Subsystems are **two-layer (protocol + backend)**; "Service" in class names is a port role, not a tier.
- New observability reads extend existing ports (`IJobRunService`, etc.) OR create a new peer port — they do not sit "above" a repo.
- The entity-code rule `use-case → service → repo` is entity-pipeline-only; applying it to framework subsystems would invent a layer that doesn't exist.
- Cross-subsystem composition precedent is `BridgeModule`: a new module consuming sibling tokens via DI; the observability composer should mirror this shape.
