---
name: bridge
description: Load when working on the Event-to-Job Bridge subsystem. Triggers include anything under `runtime/subsystems/bridge/`; the `IJobBridge` / `IEventFlow` protocols; `jobTriggers(...)` declarations and their scan (`bridge-registry-generator.ts`); the `bridge_delivery` table or its Drizzle/Memory backends; the outbox drain hook starting runs with `JobStarter` (JOBS-3); `BridgeModule.forRoot()` wiring; the `bridgeRegistry` codegen output; the `codegen events consumers <type>` CLI; and any work referencing ADR-023 or BRIDGE-1..9 specs.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

# Bridge Domain Skill

**Phase status:** Shipped 2026-04-22 via BRIDGE-1..9 (PRs #168, #169, #170, #171, #172, #174, #175, #176, #177). ADR-023 status is `Shipped`. Retention sweep (BRIDGE-10 / #173) is a pending fast-follow, explicitly out of Phase 2 scope.

The bridge is the **combiner subsystem** between events (ADR-024) and jobs (ADR-022). Neither events nor jobs imports from the bridge; the bridge imports from both. Its job is to turn "an event was published" into "a job was started" — durably, typed, idempotent, observable.

## Mental model

**Three tiers of event-driven work.** The bridge is Tier 3; authors pick tier by use case.

| Tier | Mechanism | Durability | Latency | Use for |
|---|---|---|---|---|
| 1. Subscribe | `IEventBus.subscribe()` / `@OnEvent` in-process | None (at-most-once) | ~ms | metrics, cache busts, logs |
| 2. Direct invoke | `eventFlow.publishAndStart(event, jobType, input)` | Yes (caller tx) | ~1 poll cycle | request-path work needing durability |
| 3. Bridge | `jobTriggers('<key>', [{ event, map, when }])` beside the job | Yes (outbox + ledger) | ~1 s (the executor's open-run sweep) | durable async fanout |

Tier 2 and Tier 3 both flow through the bridge subsystem at runtime. Tier 1 is events-only and bypasses the bridge entirely.

**The drain starts the run (JOBS-3, ADR-023's 2026-11-26 note).** When the outbox drain claims a `domain_events` row, the drain hook, in that event's transaction, per matched trigger: inserts the `bridge_delivery` row (`ON CONFLICT DO NOTHING`; a conflict is Case B or a replay, skipped), marks it `skipped` if the job isn't registered here (`trigger_unregistered`) or `when` is false (`predicate_false`), else calls `JobStarter.start(jobKey, map(event), { tenantId, trigger: 'event' }, tx)` and marks it `delivered` with the run id. The executor's open-run sweep finds the run after the commit. No wrapper job, no reserved pools.

**Pools are the jobs subsystem's** (limiters a step names); the bridge has none.

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
| Jobs side (the engine, JobStarter, pools, job factories) | `.claude/skills/jobs/SKILL.md` |

L1 routing files (e.g., `authoring-triggers.md`, `protocol-and-backends.md`, `facade-semantics.md`) will be added by the implementing session as depth accumulates — per the living-docs principle in CLAUDE.md, don't pre-author them.

## Non-obvious rules (the seven locked decisions)

Decisions 1–7 from ADR-023. Read the ADR for rationale; this is the compact form:

1. **Triggers are job-owned**, declared with `jobTriggers('<job key>', [...])` beside the job's `defineJob`. Events subsystem stays zero-knowledge about jobs. Do NOT declare triggers on the event YAML side.
2. **Exactly once is the event's transaction + the UNIQUE key**, never a dedupe key or window: the delivery row and the run commit together or not at all.
3. **`map:` and `when:` are typed TS callbacks**, not YAML path strings. They get typechecked against `PayloadOfType<T>`.
4. **`bridge_delivery.status` is four-state** (`pending | delivered | skipped | failed`). A throw in `map` or a refused input rolls the event back; the drain retries the event. No sweeper.
5. **Build-time validation against `eventRegistry`** at `just gen-all`. Unknown event types hard-error.
6. **`when:` predicates.** If provided and false, the drain records `status=skipped` (`predicate_false`) and starts nothing.
7. **`IEventFlow` facade** with two verbs — `publish()` and `publishAndStart()`. All request-path publishing goes through the facade, not through `IEventBus` directly. Subscribers (Tier 1) remain declarative and bypass the facade.

### `publishAndStart` + `triggers:` collision handling

When a caller uses `publishAndStart(event, jobType, input)` AND the same `jobType` has a declared `triggers:` entry for `event.type`:

- Facade pre-writes `bridge_delivery(event_id, trigger_id, user_run_id=eagerRunId, status='delivered')` in the same transaction as the eager `JobStarter.start()`.
- Outbox drain later attempts to insert its own delivery for the same `(event_id, trigger_id)` → `UNIQUE` violation → drain catches per-trigger and skips (other triggers for the same event still fire normally — the drain uses per-trigger conflict handling, not per-event).
- Result: exactly one user-job execution per (event, trigger) pair regardless of invocation path.

### Pool alignment guidance

Concurrency is the jobs subsystem's: a step's limiter (`jobs.pools`). The bridge adds no pool.

### Ordering guarantees

Default configuration gives parallelism, not ordering, and a bridge start carries no dedupe key, so per-aggregate ordering of bridge-started runs is not built (ADR-022's `concurrency_key` is gone); Tier 2 with a `dedupeKey` + `collision: 'queue'` is the way today.

### Audit-tier guard (defense-in-depth)

`tier:audit` events (lifecycle / observability — `crm_sync_started`, `connection.created`, etc.) are **not bridge-eligible**. The codegen-side validator (AUDIT-2) blocks the registry from listing them as triggers, so the registry is the **primary** enforcement. `BridgeOutboxDrainHook.processEvent` adds a **defense-in-depth** runtime guard — but the guard runs **after** the registry lookup, and the distinction matters:

- **Audit event WITH a registered trigger** (genuine drift — AUDIT-2 should have prevented it): the hook short-circuits, writes no `bridge_delivery` rows, returns `{ delivered: 0, dedupSkips: 0, triggerCount: 0, auditBlocked: 1 }`, and logs a WARN naming the offending trigger id(s). A WARN fires once per `(event_type, process)` via a `Set<string>` (`warnedAuditTypes`). `auditBlocked` rides on every per-event drain return so observability layers can aggregate without a new protocol method.
- **Audit event with NO trigger** (the common, benign case — a lifecycle event sharing the outbox with domain events): returns all zeros (`auditBlocked: 0`), **silently**. No WARN.

> **Non-obvious rule (do not get this wrong).** The guard's WARN is **not** "an audit event reached the drain." Audit events reach the drain constantly — they share the outbox. The drift signal is specifically *audit-tier event + a trigger registered against it*. Warning on every audit event is a false positive (the bug fixed 2026-06-07; see plan §AUDIT-4 revision note + `ai-docs/specs/2026-06-07-bridge-audit-guard-false-positive.md`). The guard MUST look up triggers before deciding to warn.

> **To make a workflow/directive react to a lifecycle moment** (e.g. "when a connection is created, do X"), **emit a typed domain change-fact — never make the audit lifecycle event bridge-eligible.** Declare a domain-tier change event on the entity's `events:` block (the `message_created` path / EMIT-CHANGES seam, `docs/specs/EMIT-CHANGES-1.md`). That gives the engine a bridge-eligible domain event to bind a trigger to, while the audit tier stays inert. Promoting the audit event would defeat the AUDIT-2 invariant and re-introduce the false-positive class above.

Spec reference: `ai-docs/specs/issue-242/plan.md` §AUDIT-4.

There is **no** `IObservability` read for audit-blocks today — see plan §AUDIT-4 "Why no `IObservability` read in this PR." Two clean follow-up paths if a consumer asks: a `getBridgeAuditBlocks(windowHours)` read on the bridge port + observability composer, or a self-published `bridge.audit_blocked` audit-tier event surfaced by the AUDIT-5 viewer.

### Multi-tenancy

When `multiTenant=true`, two enforcement sites need `assertTenantId` on entry:
(a) `EventFlowService.publishAndStart`, (c) `DrizzleBridgeDeliveryRepo.insertDelivery` (before write). ADR-022's (b),
the wrapper handler, is gone (JOBS-3). Same error shape at every site — precedent: JOB-8 / SYNC-6.

**Read methods deliberately bypass `assertTenantId`** (introduced via OBS-3, `IJobBridge.getStatusHistogram`). Reads with `tenantId === undefined` mean *cross-tenant view* by design — appropriate for framework-internal admin dashboards. Writes still fail loud on missing tenant context. When adding a new read method to `IJobBridge`, do NOT call `assertTenantId`; document the cross-tenant semantics in JSDoc instead. The asymmetry is intentional: writes have a single-tenant correctness invariant; reads can legitimately scope to all tenants.

## Do not

- **Do not collapse the three tiers** into "the bridge is the only path." Tier 1 subscribers remain valid for cheap in-process reactions. Tier 2 (`publishAndStart`) is the request-path durable option. Tier 3 (`triggers:`) is async fanout. The right tool depends on durability + latency needs.
- **Do not make the bridge lean on a dedupe key or window** for exactly-once.
- **Do not re-open ADR-023 decisions** without a new dated revision note. The ADR has been through a review pass and is locked for Phase 2. Additions / clarifications go in revision notes, not by rewriting decided sections.
- **Do not ship a sweeper or retry scheduler** for `bridge_delivery.failed`. Explicitly out of scope for Phase 2 — mirrors events outbox stance.
- **Do not build event-owned triggers** (`events/<name>.yaml` listing downstream jobs) as the primary authoring surface. Rejected in Alternative D. A future YAML authoring style can be added additively as a second codegen source into the same `bridgeRegistry`.
- **Do not ship dual-mode triggers** (`mode: 'bridge' | 'immediate'`) or direction-based auto-routing. Rejected as alternatives F and G — use case doesn't exist; direction is provenance, not latency profile.
- **Do not use `Date.now()` or randomness for `trigger_id`.** It's codegen-emitted as `<jobType>#<triggerIndex>`, stable across generations so replays resolve to the same `bridge_delivery` row.
- **Do not drop `tenantId`** when `multiTenant=true`. Event metadata carries it from `TypedEventBus`; the drain passes it to `JobStarter.start` as the run's tenant. Missing → `MissingTenantIdError` at the facade or the repo.

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
- `.claude/skills/jobs/SKILL.md` — jobs side (`@pattern-stack/jobs`, `JobStarter`, job factories).
- `docs/specs/JOBS-3.md` — the jobs engine the bridge starts runs on (ADR-022 is superseded).
- `docs/adrs/ADR-024-events-domain-formalization.md` — the typed event registry this ADR builds on.
- `docs/adrs/ADR-039-declarative-time-based-scheduling.md` — **time as an event source.** A scheduled event (`schedule:` on its YAML) is materialised into the outbox by the `EventScheduler` and activates jobs through THIS bridge unchanged. Provenance: a bridge run from a scheduled tick reads `trigger_source='event'` (it came through an event); the clock origin lives on `domain_events.metadata.triggerSource='schedule'`, joinable via `trigger_ref → domain_events.id`. The bridge needs no scheduling awareness — a scheduled event is just an event.
- `docs/adrs/ADR-026-job-observability.md` (not yet written) — selective job lifecycle events; flows back through this bridge.
- `.claude/skills/openapi/SKILL.md` — OpenAPI/Swagger surface (shipped 2026-04-22 via OPENAPI-1..4). ADR-026's `/ops/*` controllers will consume the registry + decorators this skill documents.
