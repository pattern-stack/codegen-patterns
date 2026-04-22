---
name: bridge
description: Load when working on the Event-to-Job Bridge subsystem. Triggers include anything under `runtime/subsystems/bridge/`; the `IJobBridge` / `IEventFlow` protocols; `@JobHandler.triggers` decorator metadata; the `bridge_delivery` table or its Drizzle/Memory backends; the framework `BridgeDeliveryHandler` wrapper on reserved `events_*` pools; `BridgeModule.forRoot()` wiring; the `bridgeRegistry` codegen output; the `codegen events consumers <type>` CLI; and any work referencing ADR-023 or BRIDGE-1..9 specs.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

# Bridge Domain Skill

**Phase status:** Planned, not shipped. ADR-023 revised 2026-04-21; BRIDGE-1..9 specs cut from `docs/specs/BRIDGE-PHASE-2-PLAN.md`. Runtime code at `runtime/subsystems/bridge/` is pending implementation. This skill ships pre-implementation so that the executing session has a single load-on-touch entry point; update the "Current runtime snapshot" section as files land.

The bridge is the **combiner subsystem** between events (ADR-024) and jobs (ADR-022). Neither events nor jobs imports from the bridge; the bridge imports from both. Its job is to turn "an event was published" into "a job was started" — durably, typed, idempotent, observable.

## Mental model

**Three tiers of event-driven work.** The bridge is Tier 3; authors pick tier by use case.

| Tier | Mechanism | Durability | Latency | Use for |
|---|---|---|---|---|
| 1. Subscribe | `IEventBus.subscribe()` / `@OnEvent` in-process | None (at-most-once) | ~ms | metrics, cache busts, logs |
| 2. Direct invoke | `eventFlow.publishAndStart(event, jobType, input)` | Yes (caller tx) | ~1 poll cycle | request-path work needing durability |
| 3. Bridge | `@JobHandler({ triggers: [{ event, map, when }] })` | Yes (outbox + ledger) | 2–3 poll cycles | durable async fanout |

Tier 2 and Tier 3 both flow through the bridge subsystem at runtime. Tier 1 is events-only and bypasses the bridge entirely.

**Reserved `events_*` pools host framework wrappers.** When the outbox drain claims a `domain_events` row, it inserts — in a single per-event transaction — one `bridge_delivery` ledger row + one wrapper `job_run` row (`type=@framework/bridge_delivery`, `pool=events_<direction>`) per matched trigger. The wrapper is claimed by the ordinary job worker. Its handler reads the ledger, evaluates `when:`, applies `map:`, calls `orchestrator.start(userJob, mapped, { parentRunId: self })`, updates the ledger to `delivered`. The user job runs in its declared pool, parented to the wrapper so cascade-cancel works.

**Two pool layers.** Pool A (reserved `events_*`) holds wrappers — cheap, high concurrency. Pool B (user-declared `@JobHandler.pool`) holds the actual work — author picks by scarce-resource-protected. Pool-per-class-of-work, 4–8 pools typical.

**The ledger is the single source of truth.** `UNIQUE (event_id, trigger_id)` on `bridge_delivery` is the idempotency primitive. It dedups: (a) outbox replay, (b) `publishAndStart` + declared `triggers:` collision (facade pre-writes a `status=delivered` row; drain's later INSERT fails UNIQUE and skips).

## Routing table

This skill is a single file pre-implementation. Load-on-touch depth comes from the authoritative documents:

| Task | Read |
|---|---|
| Anything design-level (the decisions, the flow, why) | `docs/adrs/ADR-023-event-to-job-bridge.md` |
| Orchestration / PR stack / gate locations | `docs/specs/BRIDGE-PHASE-2-PLAN.md` |
| Implementing a specific PR in the stack | `docs/specs/BRIDGE-N.md` for that N |
| Review-pass context / what NOT to re-open | `docs/specs/ADR-023-handoff.md` |
| Events side (registry, directions, outbox) | `.claude/skills/events/SKILL.md` |
| Jobs side (pools, orchestrator, worker loop) | `.claude/skills/jobs/SKILL.md` |

L1 routing files (e.g., `authoring-triggers.md`, `protocol-and-backends.md`, `facade-semantics.md`) will be added by the implementing session as depth accumulates — per the living-docs principle in CLAUDE.md, don't pre-author them.

## Non-obvious rules (the seven locked decisions)

Decisions 1–7 from ADR-023. Read the ADR for rationale; this is the compact form:

1. **Triggers are job-owned**, declared on `@JobHandler({ triggers: [...] })`. Events subsystem stays zero-knowledge about jobs. Do NOT declare triggers on the event YAML side.
2. **The bridge IS the jobs worker** draining reserved pools. No separate worker process, no subscriber-in-events-subsystem implementation. Wrappers are normal `job_run` rows.
3. **`map:` and `when:` are typed TS callbacks**, not YAML path strings. They get typechecked against `PayloadOfType<T>`.
4. **`bridge_delivery.status` is four-state** (`pending | delivered | skipped | failed`). No auto-retry beyond the wrapper's own retry policy. No sweeper.
5. **Build-time validation against `eventRegistry`** at `just gen-all`. Unknown event types hard-error.
6. **`when:` predicates ship in Phase 2.** If provided and returns false, wrapper records `status=skipped` with a reason and does not spawn the user job.
7. **`IEventFlow` facade** with two verbs — `publish()` and `publishAndStart()`. All request-path publishing goes through the facade, not through `IEventBus` directly. Subscribers (Tier 1) remain declarative and bypass the facade.

### `publishAndStart` + `triggers:` collision handling

When a caller uses `publishAndStart(event, jobType, input)` AND the same `jobType` has a declared `triggers:` entry for `event.type`:

- Facade pre-writes `bridge_delivery(event_id, trigger_id, user_run_id=eagerRunId, wrapper_run_id=null, status='delivered')` in the same transaction as the eager `orchestrator.start()`.
- Outbox drain later attempts to insert its own delivery for the same `(event_id, trigger_id)` → `UNIQUE` violation → drain catches per-trigger and skips (other triggers for the same event still fire normally — the drain uses per-trigger conflict handling, not per-event).
- Result: exactly one user-job execution per (event, trigger) pair regardless of invocation path.

### Pool alignment guidance

Reserved `events_*` pools get high concurrency (default 32) — they host cheap wrappers. User pools (`outbound_email`, `external_crm`, etc.) get concurrency tuned to the scarce resource behind them. Do NOT route user work into reserved pools (module-init rejects it).

### Ordering guarantees

Default configuration gives parallelism, not ordering. For per-aggregate ordering, prefer `concurrency_key` on the user `@JobHandler` (granular, parallel across aggregates) over `pool.concurrency = 1` (blunt, serializes all wrappers in that direction).

### Multi-tenancy

When `multiTenant=true`, three enforcement sites need `assertTenantId` on entry:
(a) `EventFlowService.publishAndStart`, (b) `BridgeDeliveryHandler.handle`, (c) `DrizzleBridgeDeliveryRepo.insertDelivery` (before write). Same error shape at every site — precedent: JOB-8 / SYNC-6.

## Do not

- **Do not collapse the three tiers** into "the bridge is the only path." Tier 1 subscribers remain valid for cheap in-process reactions. Tier 2 (`publishAndStart`) is the request-path durable option. Tier 3 (`triggers:`) is async fanout. The right tool depends on durability + latency needs.
- **Do not put user `@JobHandler` classes on reserved `events_*` pools.** Module init rejects it. Framework handlers live there.
- **Do not re-open ADR-023 decisions** without a new dated revision note. The ADR has been through a review pass and is locked for Phase 2. Additions / clarifications go in revision notes, not by rewriting decided sections.
- **Do not ship a sweeper or retry scheduler** for `bridge_delivery.failed`. Explicitly out of scope for Phase 2 — mirrors events outbox stance.
- **Do not build event-owned triggers** (`events/<name>.yaml` listing downstream jobs) as the primary authoring surface. Rejected in Alternative D. A future YAML authoring style can be added additively as a second codegen source into the same `bridgeRegistry`.
- **Do not ship dual-mode triggers** (`mode: 'bridge' | 'immediate'`) or direction-based auto-routing. Rejected as alternatives F and G — use case doesn't exist; direction is provenance, not latency profile.
- **Do not claim Phase 2 is shipped** until BRIDGE-9 merges. Until then: "defined," "planned," "in-flight" — not "shipped."
- **Do not use `Date.now()` or randomness for `trigger_id`.** It's codegen-emitted as `<jobType>#<triggerIndex>`, stable across generations so replays resolve to the same `bridge_delivery` row.
- **Do not drop `tenantId`** when `multiTenant=true`. Event metadata carries it from `TypedEventBus`; the bridge threads it into `job_run.tenant_id` via `orchestrator.start()`. Missing → `MissingTenantIdError` at any of the three enforcement sites.

## Current runtime snapshot

**None.** The `runtime/subsystems/bridge/` directory does not exist yet. BRIDGE-1..9 will populate it. When they land, this section should be rewritten to mirror the "Current runtime snapshot" sections in events SKILL and jobs SKILL — listing each shipped file with a one-line purpose.

Expected files (per BRIDGE-PHASE-2-PLAN.md):

```
runtime/subsystems/bridge/
  bridge.protocol.ts                       # IJobBridge + IEventFlow + DI tokens
  bridge-delivery.schema.ts                # bridge_delivery table + status enum
  bridge-delivery.drizzle-backend.ts       # Postgres repo + drain integration
  bridge-delivery.memory-backend.ts        # test double
  bridge-delivery-handler.ts               # framework @framework/bridge_delivery handler
  event-flow.service.ts                    # IEventFlow impl (publish + publishAndStart)
  bridge.module.ts                         # BridgeModule.forRoot({ backend, multiTenant })
  generated/registry.ts                    # codegen-emitted bridgeRegistry
  index.ts                                 # barrel
```

Codegen & CLI additions:

```
src/cli/shared/bridge-registry-generator.ts
src/cli/shared/bridge-scaffold-locals.ts
src/cli/commands/events/consumers.ts      # `codegen events consumers <type>` fanout CLI
```

## Cross-links

- `docs/adrs/ADR-023-event-to-job-bridge.md` — authoritative ADR.
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — orchestration plan, 9-PR stack, gate locations.
- `docs/specs/ADR-023-handoff.md` — review-pass summary + what the executing session should / should not do.
- `docs/specs/BRIDGE-1.md` … `BRIDGE-9.md` — per-PR implementation specs (cut in parallel with this skill).
- `.claude/skills/events/SKILL.md` + `phase-roadmap.md` + `directions-and-pools.md` — events side.
- `.claude/skills/jobs/SKILL.md` — jobs side; reserved-pool rules and wrapper handler registration.
- `docs/adrs/ADR-022-job-orchestration-domain-model.md` — reserved `events_*` pools originate here; `trigger_source='event'` + `trigger_ref=<event_id>` columns on `job_run` already anticipated this ADR.
- `docs/adrs/ADR-024-events-domain-formalization.md` — the typed event registry this ADR builds on.
- `docs/adrs/ADR-026-job-observability.md` (not yet written) — selective job lifecycle events; flows back through this bridge.
