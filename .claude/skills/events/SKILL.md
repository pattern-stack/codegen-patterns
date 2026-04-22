---
name: events
description: Use when working on IEventBus, domain event publishing, the transactional outbox (domain_events table), subscribers, the event-codegen formalization (events/*.yaml, AppDomainEvent union, typed TypedEventBus facade, direction routing into events_* pools), or anything in runtime/subsystems/events/. Load this before touching event shape, publish/subscribe call sites, outbox polling, or cross-subsystem wiring into jobs' reserved event pools.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

# Events Domain Skill

Events are the domain's immutable record of *something that happened*. They are written inside the same Drizzle transaction as the domain change (transactional outbox), drained asynchronously, and delivered to subscribers. This skill covers the current runtime (`IEventBus`, the `domain_events` outbox, Drizzle/Memory backends) **plus** the shipped events-codegen pipeline (ADR-024 Phase 1) that generates a typed event registry, typed `TypedEventBus` facade, and direction-based pool routing.

## Mental model

**Events vs. jobs — a sharp distinction, memorize it:**

- **Events are immutable facts.** "Contact was created." "Stripe webhook arrived." "Opportunity stage changed to `won`." They have no lifecycle of their own beyond pending → processed in the outbox. Nothing about an event retries or fails in the domain sense — what retries is a *handler* or a *downstream job*.
- **Jobs are stateful work.** They have status (`pending | running | waiting | completed | failed | canceled`), retry policies, hierarchy, scope, signals. They can be canceled, replayed, reorganized. See the jobs SKILL.md sibling.

If you are tempted to put `status`, `attempts`, or `retry_policy` fields on an event — stop. You want a job. The event is the *trigger*; the job is the *work*.

**Three event directions** — this is the single most important routing concern in the subsystem:

| direction  | what it carries                                     | example                          | default pool       |
|------------|-----------------------------------------------------|----------------------------------|--------------------|
| `inbound`  | external → us. Webhooks, pub/sub, inbound email     | `stripe_payment_received`        | `events_inbound`   |
| `change`   | internal domain mutations. Drives projections       | `contact_created`                | `events_change`    |
| `outbound` | us → external. Webhooks fired, sync pushes          | `webhook_outbound_contact_sync`  | `events_outbound`  |

Direction is a **routing** concern, not a payload concern. Payload shape is per-event-type. The same direction can carry wildly different payloads; two events with identical payloads can have different directions. Don't collapse them.

**Reserved `events_*` pools** — the jobs subsystem (ADR-022, jobs SKILL.md) reserves three pools — `events_inbound`, `events_change`, `events_outbound` — *exclusively* for the IEventBus outbox drain. User `@JobHandler` decorations that target a reserved pool fail at build time. These pools exist so a slow outbound handler cannot stall change-event propagation. The Drizzle outbox drain loop claims rows by pool (see `outbox-and-transactions.md`).

**The IEventBus + typed facade story:**

- `IEventBus` (protocol, `runtime/subsystems/events/event-bus.protocol.ts`) stays narrow: `publish(event, tx?)`, `publishMany(events, tx?)`, `subscribe(type, handler)`. It is the hexagonal port. Backends implement it. **It does not know about the generated registry** — that would be circular coupling.
- `TypedEventBus` (generated into `runtime/subsystems/events/generated/bus.ts`, see `event-codegen.md`) is a thin injectable wrapper with typed overloads. It stamps `metadata.pool`, `metadata.direction`, and `metadata.version` onto every publish based on the generated registry. Application code uses `TypedEventBus`; `IEventBus` is the lower-level port.

`IEventBus` was unchanged by the ADR-024 Phase 1 rollout — the typed facade wraps it without breaking it.

## Task → L1 routing

| When the task involves…                                                             | Read                            |
|--------------------------------------------------------------------------------------|---------------------------------|
| Publishing inside a transaction, outbox semantics, idempotency, polling             | `outbox-and-transactions.md`    |
| The YAML formalization (`events/*.yaml`), generated types/schemas/registry, TypedEventBus facade | `event-codegen.md`  |
| Why there are three directions, why pools are isolated, cross-link to jobs pools    | `directions-and-pools.md`       |
| IEventBus contract, Drizzle/Memory backends, adding a new backend                   | `protocol-and-backends.md`      |
| Deciding what Phase 1 shipped vs. what's deferred (ADR-023 bridge, Phase B, versioning) | `phase-roadmap.md`           |

## Non-obvious rules (read twice)

1. **Direction is a routing concern, not a payload concern.** Two events with the same payload can have different directions because the drain lane matters. An `inbound` webhook that mirrors a `change` event is still `inbound` — the lane it drains through is what keeps external bursts from stalling internal projections.
2. **The outbox is transactional.** `IEventBus.publish(event, tx)` inside a Drizzle transaction means the event row is part of the same write. If the transaction rolls back, the event is never persisted. No phantom events. **Always pass `tx` when publishing from a use case that also writes domain state.** Dropping `tx` silently detaches the event from the transaction — the domain write can commit while the event insert fails independently.
3. **Events do not have a lifecycle; jobs do.** The `status` column on `domain_events` (`pending | processed | failed`) is a *delivery* state for the outbox drain, not a domain state. It is not a retry policy, not a scope, not a cancellable thing. If you need any of those, you want a job triggered by the event.
4. **The events-codegen formalization (`events/*.yaml`) generates the union, the registry, and the facade — Phase 1 has shipped.** `events/<name>.yaml` produces five files under `runtime/subsystems/events/generated/` (copied into `<paths.subsystems>/events/generated/` on scaffold):
   - `types.ts` — `AppDomainEvent` discriminated union, `EventOfType<T>`, `PayloadOfType<T>`
   - `schemas.ts` — Zod payload schemas, runtime-validated at the publish boundary
   - `registry.ts` — `eventRegistry` keyed by type with `direction`, `pool`, `aggregate`, etc.
   - `bus.ts` — `TypedEventBus` with typed `publish<T>()` and `subscribe<T>()`
   - `index.ts` — re-export surface
   Governed by ADR-024 (Phase 1 scope = EVT-1..EVT-8). See `event-codegen.md` for the YAML shape and `phase-roadmap.md` for what's deferred.
5. **Phase ordering matters.** Events codegen is a hard prerequisite for the jobs Event-to-Job Bridge (ADR-023). The bridge reads the event registry to validate trigger references, extract typed scope from payloads, and auto-assign pools. Ship events registry → ship events typed facade → *then* land the bridge. Don't skip.
6. **Change events MAY be declared via the entity `events:` block.** At parse time the generator desugars the entity block into top-level `events/<name>.yaml` with `direction: change` and `aggregate: <entity>`. Per-entity inline blocks are sugar; they are not a second source of truth.
7. **Entity auto-emission requires opt-in via `emits:`.** The target design (Phase C) is: entities declare `emits: [contact_created, contact_updated, ...]` in their YAML; generated use-cases emit typed events via `TypedEventBus.publish(type, aggregateId, payload, { tx })` inside the transaction. Silent auto-emission by name is being phased out.

## Do not

- Do not put job-style fields on events (`retry_count`, `status: pending|running|waiting|completed`, `scope`, `parent_id`, `attempts`). Those belong on `job_run`.
- Do not call `IEventBus.publish` with untyped string types once the typed facade is generated for your project. Use `TypedEventBus.publish<'contact_created'>(...)`. The generated registry is the single source of truth for what the app emits.
- Do not collapse `inbound | change | outbound` into a single pool. Lane isolation is the whole point — a slow outbound handler must not stall change-event propagation.
- Do not couple two services via direct method calls when the second reacts to a state change in the first. Publish a domain event from the first service's use case (inside the transaction), subscribe from the second. Direct imports create retrograde coupling and make the reaction invisible in audit logs and tests.
- Do not drop the `tx` parameter in `publish(event, tx)` inside a use case. The outbox guarantee *is* the `tx`.
- Do not put arbitrary "notify Slack" / "call external API" logic in a subscriber directly. Subscribers should enqueue a job (via the jobs bridge) that lives in the `events_outbound` pool and carries retry/timeout. Handlers that make HTTP calls block the outbox drain.
- Do not create `*.deprecated.ts`, parallel "old + new" event shapes, or migration shims. There are no external consumers yet; replace cleanly. See CLAUDE.md operating principles.
- Do not add new protocol methods to `IEventBus` without an ADR. The narrow three-method port is deliberate — typing, routing, and metadata enrichment live in the typed facade.

## Current runtime snapshot

Files that ship to the consumer app (not templates):
- `runtime/subsystems/events/event-bus.protocol.ts` — `IEventBus`, `DomainEvent`
- `runtime/subsystems/events/domain-events.schema.ts` — outbox table with first-class `pool` / `direction` columns (EVT-1); `tenant_id` is a scaffold-time conditional emitted by the Hygen template, not by this runtime source (EVT-8 precedent mirrors JOB-6)
- `runtime/subsystems/events/event-bus.drizzle-backend.ts` — outbox poller (`FOR UPDATE SKIP LOCKED`); pool-filtered drain via `opts.pools`
- `runtime/subsystems/events/event-bus.memory-backend.ts` — sync test backend, exposes `publishedEvents[]`, `publishedEventsForPool()`, `publishedEventsForDirection()`, `clear()`; accepts `opts.pools` for pool-filtered dispatch that mirrors the Drizzle drain (EVT-5)
- `runtime/subsystems/events/event-bus.redis-backend.ts` — alternate backend (runtime only; not offered by the `subsystem install events` scaffold surface in Phase 1)
- `runtime/subsystems/events/events.module.ts` — `EventsModule.forRoot({ backend, multiTenant?, pools? })`, `global: true`; provides `EVENT_BUS`, `TYPED_EVENT_BUS`, `EVENTS_MULTI_TENANT`
- `runtime/subsystems/events/events.tokens.ts` — `EVENT_BUS`, `TYPED_EVENT_BUS`, `EVENTS_MULTI_TENANT`, `EVENTS_MODULE_OPTIONS` (all string-valued), `REDIS_URL` (Symbol)
- `runtime/subsystems/events/events-errors.ts` — `MissingTenantIdError` (thrown by `TypedEventBus.publish` when `multiTenant: true` and `metadata.tenantId` missing)
- `runtime/subsystems/events/generated/` — the five generated artifacts (`types.ts`, `schemas.ts`, `registry.ts`, `bus.ts`, `index.ts`) produced from `events/*.yaml` by `event-codegen-generator.ts`; `bus.ts` defines `TypedEventBus`, injects `EVENT_BUS` + `EVENTS_MULTI_TENANT`, stamps `pool` / `direction` / `version` onto publish metadata, and enforces tenantId when multi-tenant mode is on
- `runtime/base-classes/lifecycle-events.ts` — legacy fire-and-forget auto-emission; being replaced by `emits:` declarations

Generator pieces:
- `templates/subsystem/events/` — main scaffold (`prompt.js`, `domain-events.schema.ejs.t`, `generated-keep.ejs.t`) — always emitted on `subsystem install events`
- `templates/subsystem/events-config/` — config-block scaffold (`prompt.js`, `codegen-config-events-block.ejs.t`) — emitted on first install; `subsystem install events --force` alone preserves an existing block (#121 / F13), `--force-config` opts into regeneration
- `src/cli/shared/events-scaffold-locals.ts` — resolves Hygen locals (appName, multiTenant, configPath, schemaPath, generatedKeepPath)
- `src/cli/shared/event-codegen-generator.ts` — produces the five `generated/` files from `events/*.yaml` and entity `events:` / `emits:` blocks

## Three tiers of event-driven work (ADR-023)

Subscribers are one of three sanctioned patterns. Pick by durability and latency:

| Tier | Mechanism | Durability | Latency | Use for |
|---|---|---|---|---|
| 1. Subscribe | `IEventBus.subscribe()` / `@OnEvent` (in-process) | None (at-most-once) | ~ms | metrics, cache busts, logs |
| 2. Direct invoke | `eventFlow.publishAndStart(...)` (facade, Phase 2 planned) | Yes (caller tx) | ~1 poll cycle | request-path work needing durability |
| 3. Bridge | `@JobHandler({ triggers: [...] })` (Phase 2 planned) | Yes (outbox + ledger) | 2–3 poll cycles | durable async fanout |

Tier 2 and Tier 3 ship with BRIDGE-1..9 (ADR-023 Phase 2, defined not shipped). Today, only Tier 1 is runtime-available.

## Cross-links

- Jobs SKILL.md — the reserved `events_*` pools, the Event-to-Job Bridge (ADR-023), why handlers should enqueue jobs rather than do heavy work inline.
- Bridge SKILL.md (`.claude/skills/bridge/SKILL.md`) — the combiner subsystem (Phase 2 planned, pending BRIDGE-1..9 implementation).
- `docs/adrs/ADR-008-subsystem-architecture.md` — the Protocol → Backend → Factory pattern events follows.
- `docs/adrs/ADR-022-job-orchestration-domain-model.md` — the job-side story for the pools and the bridge.
- `docs/adrs/ADR-023-event-to-job-bridge.md` — the authoritative ADR governing Phase 2 (revised, specs cut, implementation pending).
- `docs/adrs/ADR-024-events-domain-formalization.md` — the authoritative ADR governing Phase 1 (shipped via EVT-1..EVT-8).
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — orchestration plan for the 9-PR bridge rollout.
- `docs/specs/events-codegen-plan.md` — superseded plan (historical context only; decisions captured in ADR-024 and `event-codegen.md`).
